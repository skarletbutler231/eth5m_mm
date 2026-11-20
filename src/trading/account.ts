// ACCOUNT — paper USDC and per-window inventory.
//
// Each 5-minute window is its own market, so inventory is kept per window: Up shares, Down shares and the
// USDC paid for each (for the average price). Every price arrives in Up terms:
//   BUY  Up at p     → +Up,   −p·s.
//   BUY  Down at q   → +Down, −q·s.
//   SELL Up at p     → −Up, +p·s (not sent by the bot; kept for completeness: any part beyond the Up held
//                      books as the equal Down buy at 1 − p).
// Then MERGE: 1 Up + 1 Down redeem for $1 at any time (CTF merge), so pairs are merged at once and at most
// one side is ever held. Net = Up − Down is the position: +n pays $n if UP, −n pays $n if DOWN.
// SETTLE: the winning token pays $1. A Gamma correction of a provisional label re-settles the difference.
//
// PnL of a window = its cash flow (fills, merges, payout) + what is still held, marked at the mid.
// Equity = cash + every unsettled window marked. Edge = (FV − price) per share at the fill, signed for our
// side: what the fill was worth by the model at that instant. PnL − edge is what happened after (drift,
// adverse selection).
//
// REBATE: Polymarket pays makers 20% of the taker fees, daily, pro rata by each maker's fee-equivalent 0.07·p(1−p) per
// filled share. Every share a maker fills is a share some taker paid that fee on, so the rebate per maker share is
// PAPER_MAKER_REBATE (0.2) × 0.07·p(1−p). It is credited at the fill (accrued; the real payout comes once a day).
import { takerFee } from "./paperExchange.js";
import { cents, type Fill, type Side } from "./types.js";

export interface WinPos {
  win: number;
  endTs: number;
  up: number; down: number;
  upCost: number; downCost: number;
  cash: number;                   // this window's net cash flow
  realized: number;
  fills: number; bought: number; sold: number; notional: number;   // bought = Up shares bought, sold = Down shares bought
  /** Maker fills by the cancel at the fill: our cancel already sent (in flight) · none sent. fills − both = takes. */
  fillsCxl: number; fillsNoCxl: number;
  edge: number; edgeN: number;    // Σ (FV − px)·sz signed for our side, and Σ sz with an FV
  mk: [number, number, number];   // Σ markout·sz at +1 s / +5 s / +30 s
  mkN: [number, number, number];
  maxAbs: number;
  pairs: number;                  // Up+Down pairs merged for $1
  pairCost: number;               // what those pairs cost: Σ m·(avg Up + avg Down)
  fees?: number;                  // taker fees paid (USDC); makers pay none
  rebate?: number;                // maker rebates credited (USDC)
  mark: number | null;            // last good mid (falls back to FV) used for marking
  state: "open" | "settling" | "settled";
  outcome: boolean | null;
  src: string | null;
  payout: number;
  snap: { up: number; down: number } | null;   // position at settlement, for a Gamma re-settle
  placed: number; cancelled: number; rejected: number;
  /** The market's condition id (MM_MODE=live: the on-chain merge and redeem). */
  cond?: string;
  /** Its Up / Down token ids (MM_MODE=live: the wallet sync checks that Polymarket has redeemed the winning side). */
  upTok?: string; downTok?: string;
}

/** Index-entry summary of one window: plain sums, so days aggregate exactly. */
export interface PaperSummary {
  pnl: number; settled: boolean; outcome: boolean | null;
  fills: number; bought: number; sold: number; notional: number;
  /** Maker fills with our cancel in flight · with no cancel sent (absent in windows recorded before 2026-11-10). */
  fillsCxl?: number; fillsNoCxl?: number;
  edge: number; edgeN: number;
  mk: [number, number, number]; mkN: [number, number, number];
  maxAbs: number; placed: number; cancelled: number; rejected: number;
  pairs?: number; pairCost?: number; fees?: number; rebate?: number;
}

export const HORIZONS = [1000, 5000, 30_000] as const;
const tidy = (x: number) => (Math.abs(x) < 1e-9 ? 0 : x);

export function newPos(win: number, endTs: number): WinPos {
  return {
    win, endTs, up: 0, down: 0, upCost: 0, downCost: 0, cash: 0, realized: 0,
    fills: 0, bought: 0, sold: 0, notional: 0, fillsCxl: 0, fillsNoCxl: 0, edge: 0, edgeN: 0, mk: [0, 0, 0], mkN: [0, 0, 0],
    maxAbs: 0, pairs: 0, pairCost: 0, fees: 0, rebate: 0, mark: null, state: "open", outcome: null, src: null, payout: 0, snap: null,
    placed: 0, cancelled: 0, rejected: 0,
  };
}

export class Account {
  wins = new Map<number, WinPos>();
  /** Fills whose markouts are still being measured (current window only). */
  private open: Fill[] = [];

  /** rebateShare: the share of the taker fee credited on each maker fill (0 = none). */
  constructor(public start: number, public cash: number, private readonly rebateShare = 0) {}

  pos(win: number, endTs = win + 300): WinPos {
    let p = this.wins.get(win);
    if (!p) { p = newPos(win, endTs); this.wins.set(win, p); }
    return p;
  }

  net(win: number): number { const p = this.wins.get(win); return p ? p.up - p.down : 0; }

  /** Book a fill. Returns what it did to the inventory, in words. */
  apply(f: Fill): string {
    const p = this.pos(f.win);
    const { price: px, size: s } = f;
    const said: string[] = [];
    if (f.token === "DOWN" && f.tokenSide === "BUY") {
      const q = f.tokenPrice;
      p.down += s; p.downCost += q * s; this.flow(p, -q * s);
      said.push(`bought ${fmt(s)} Down @ ${cents(q)}`);
    } else if (f.side === "BUY") {
      p.up += s; p.upCost += px * s; this.flow(p, -px * s);
      said.push(`bought ${fmt(s)} Up @ ${cents(px)}`);
    } else {
      const fromUp = Math.min(s, p.up);
      if (fromUp > 0) {
        const avg = p.upCost / p.up;
        p.realized += fromUp * (px - avg);
        p.upCost -= fromUp * avg; p.up -= fromUp;
        this.flow(p, px * fromUp);
        said.push(`sold ${fmt(fromUp)} Up`);
      }
      const rest = s - fromUp;
      if (rest > 1e-9) {
        p.down += rest; p.downCost += (1 - px) * rest; this.flow(p, -(1 - px) * rest);
        said.push(`bought ${fmt(rest)} Down @ ${cents(1 - px)}`);
      }
    }
    if (f.fee) { this.flow(p, -f.fee); p.fees = (p.fees ?? 0) + f.fee; said.push(`fee $${f.fee.toFixed(3)}`); }
    if (f.via !== "take" && this.rebateShare > 0) {
      const r = this.rebateShare * takerFee(f.price) * s;          // p(1−p): the same for Up at p and Down at 1 − p
      this.flow(p, r); p.rebate = (p.rebate ?? 0) + r;
    }
    const m = this.merge(p);
    if (m.n) said.push(`merged ${fmt(m.n)} pair${m.n === 1 ? "" : "s"} at ${(m.cost * 100).toFixed(1)}¢ → ${m.cost <= 1 ? "+" : "−"}$${Math.abs(m.n * (1 - m.cost)).toFixed(2)}`);
    p.up = tidy(p.up); p.down = tidy(p.down); p.upCost = tidy(p.upCost); p.downCost = tidy(p.downCost);
    p.fills++; p.notional += (f.token === "DOWN" ? f.tokenPrice : px) * s;
    if (f.via !== "take" && f.cxl != null) {                     // (?? 0: a window restored from a save made before the counters)
      if (f.cxl) p.fillsCxl = (p.fillsCxl ?? 0) + 1; else p.fillsNoCxl = (p.fillsNoCxl ?? 0) + 1;
    }
    if (f.side === "BUY") p.bought += s; else p.sold += s;       // Up bought · Down bought (Up-terms sells)
    if (f.fv != null) { p.edge += sideSign(f.side) * (f.fv - px) * s; p.edgeN += s; }
    p.maxAbs = Math.max(p.maxAbs, Math.abs(p.up - p.down));
    this.open.push(f);
    const net = p.up - p.down;
    return `${said.join(", ")} → net ${net > 0 ? "+" : ""}${fmt(net)}`;
  }

  private flow(p: WinPos, usdc: number): void { p.cash += usdc; this.cash += usdc; }

  /** Redeem every Up+Down pair for $1. Returns how many, and what one pair cost. */
  private merge(p: WinPos): { n: number; cost: number } {
    const m = Math.min(p.up, p.down);
    if (m <= 1e-9) return { n: 0, cost: 0 };
    const au = p.upCost / p.up, ad = p.downCost / p.down;
    p.realized += m * (1 - au - ad);
    p.upCost -= m * au; p.downCost -= m * ad;
    p.up -= m; p.down -= m;
    p.pairs += m; p.pairCost += m * (au + ad);
    this.flow(p, m);
    return { n: m, cost: au + ad };
  }

  /** Each frame: mark the live window and fill in markouts that came due. True if a markout was set. */
  mark(win: number, mid: number | null, fv: number | null, now: number): boolean {
    const p = this.wins.get(win);
    if (p && (mid ?? fv) != null) p.mark = mid ?? fv;
    if (!this.open.length) return false;
    let changed = false;
    // a horizon with no good mid within 2 s of it stays unknown rather than being measured late
    for (const f of this.open) {
      if (f.win !== win) continue;
      for (let k = 0; k < 3; k++) {
        if (f.mk[k] != null || mid == null || now < f.t + HORIZONS[k] || now > f.t + HORIZONS[k] + 2000) continue;
        f.mk[k] = sideSign(f.side) * (mid - f.price);
        changed = true;
        const q = this.wins.get(f.win);
        if (q) { q.mk[k] += f.mk[k]! * f.size; q.mkN[k] += f.size; }
      }
    }
    this.open = this.open.filter((f) => f.win === win && f.mk[2] == null && now <= f.t + HORIZONS[2] + 2000);
    return changed;
  }

  /** The window closed: no more trading; markouts that did not come due stay unknown. A window that never
   *  traded has nothing to settle and is done at once. */
  close(win: number): void {
    const p = this.wins.get(win);
    if (p && p.state === "open") {
      if (!p.fills && !p.up && !p.down) { p.state = "settled"; p.snap = { up: 0, down: 0 }; p.mark = null; }
      else p.state = "settling";
    }
    this.open = this.open.filter((f) => f.win !== win);
  }

  /** Pay the winning side. Returns the window PnL, or null if there was nothing to settle. Re-settles on a correction. */
  settle(win: number, up: boolean, src: string): { pnl: number; corrected: boolean; payout: number } | null {
    const p = this.wins.get(win);
    if (!p) return null;
    if (p.state === "settled") {
      if (p.outcome === up || p.outcome == null) { p.outcome = up; p.src = src; return null; }
      const pay = up ? p.snap!.up : p.snap!.down, d = pay - p.payout;
      p.payout = pay; p.realized += d; this.flow(p, d);
      p.outcome = up; p.src = src;
      return { pnl: this.pnl(p), corrected: true, payout: pay };
    }
    p.snap = { up: p.up, down: p.down };
    const pay = up ? p.up : p.down;
    p.realized += pay - p.upCost - p.downCost;
    this.flow(p, pay);
    p.payout = pay; p.up = 0; p.down = 0; p.upCost = 0; p.downCost = 0;
    p.state = "settled"; p.outcome = up; p.src = src; p.mark = null;
    return { pnl: this.pnl(p), corrected: false, payout: pay };
  }

  value(p: WinPos): number {
    if (p.state === "settled" || p.mark == null) return p.state === "settled" ? 0 : p.upCost + p.downCost;
    return p.up * p.mark + p.down * (1 - p.mark);
  }

  pnl(p: WinPos): number { return p.cash + this.value(p); }

  equity(): number {
    let v = this.cash;
    for (const p of this.wins.values()) if (p.state !== "settled") v += this.value(p);
    return v;
  }

  /** PnL restarts at zero, cash and inventory untouched: the start becomes the equity now, and each unsettled window's
   *  cash flow is set so its PnL is zero at its mark (what it holds is carried at that value). Its fills, edge, pairs
   *  and fees stay: they are what the window did. Returns each rebased window and the PnL it had. */
  rebase(): { win: number; pnl: number }[] {
    const out: { win: number; pnl: number }[] = [];
    for (const p of this.wins.values()) {
      if (p.state === "settled") continue;
      out.push({ win: p.win, pnl: this.pnl(p) });
      p.cash = -this.value(p);
    }
    this.start = this.equity();
    return out;
  }

  summary(p: WinPos): PaperSummary {
    return {
      pnl: this.pnl(p), settled: p.state === "settled", outcome: p.outcome,
      fills: p.fills, bought: p.bought, sold: p.sold, notional: p.notional, fillsCxl: p.fillsCxl ?? 0, fillsNoCxl: p.fillsNoCxl ?? 0, edge: p.edge, edgeN: p.edgeN,
      mk: [...p.mk], mkN: [...p.mkN], maxAbs: p.maxAbs, placed: p.placed, cancelled: p.cancelled, rejected: p.rejected,
      pairs: p.pairs, pairCost: p.pairCost, fees: p.fees ?? 0, rebate: p.rebate ?? 0,
    };
  }

  /** Settled windows leave memory after an hour; their record lives in the index. */
  prune(nowSec: number): void {
    for (const [k, p] of this.wins) if (p.state === "settled" && p.endTs < nowSec - 3600) this.wins.delete(k);
  }
}

export const sideSign = (s: Side) => (s === "BUY" ? 1 : -1);
const fmt = (x: number) => x.toFixed(Math.abs(x % 1) > 1e-9 ? 2 : 0);
