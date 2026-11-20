// LOCK AND STOP (MM_LOCK_PCT; 2026-11-07 at the user's request, after live run 5 stopped at −$20). Once buying the
// short token (the one we are short of) for the whole excess |net| would lock the window's PnL at MM_LOCK_PCT × the order
// size in dollars or more whichever side wins (10 sh × 0.20 = $2), send that buy as a fill-and-kill, and stop market
// making in the window: every maker order is cancelled and none placed until it closes. A window already flat with that
// much locked stops without a take.
//   locked   the window's cash flow (fills, fees, rebates, merged pairs at $1) − q × (limit + taker fee) + |net|: what the
//            window ends with if the held token wins; if the short token wins it ends with q − |net| ≥ 0 more.
//   q        |net|, raised to the shares the venue's $1 minimum buys at the ask (a market BUY under $1 is refused)
//   limit    the ask + MM_LOCK_SLIP (at most MM_LOCK_MAX_PX); the take spends q × the ask, so a fill at the ask buys q
//   gates    MM_LOCK_FROM_SEC after the open to MM_LOCK_UNTIL_LEFT_SEC before the close, a good book, no take in flight,
//            the USDC for q × (limit + fee)
// A take that fills nothing (refused, or nothing at the limit) is sent again while the gate holds; the window stays stopped.
// The window's cash alone ≥ the target (it holds that even if the held token loses): it stops without a take. The lock
// buys one token a window, so what the $1 minimum over-bought stays held (an extra payout if that side wins).
// Replay on live run 5 (138 windows, 11-06 17:20 → 11-07 07:20 UTC, 1¢ slip): $2 locked → −$12.89 became +$8.3 and the run
// never reached −$20; but the take part alone was +$11.9 at t 0.3 (14 of 49 paid), the rest fewer maker fills, and $0–$1
// lost $39–69 (memory flatten-at-180s). Paper overlays 10-13..11-06 put every lock take at −2.4..−2.6¢ a share.
// PRICE LOCK (MM_LOCK_PX_F; 2026-11-11 at the user's request, reports/Price lock config.md): the same take and stop also
// fire once the short token's ask ≤ (1 − p)(1 − f), p = the held token's average buy price in the window, while |net| ≥
// MM_LOCK_PX_MIN_NET order sizes, whatever the window's $ locked. OR-ed with MM_LOCK_PCT (either may be off). Picked from
// 855 configs (tools/hedge/pxgrid.py): $20% OR f 0.3 with ≥ 2 orders vs $20% alone was +0.06 / −0.03 / +0.01 / +0.05 $ a
// window on live runs 1–5 / 6–9 / paper halves (|t| ≤ 1) and the worst-5% windows better in all four; no edge in the take.
import { CFG } from "./config.js";
import type { Step } from "./quoter.js";
import type { Take } from "./taker.js";
import { takerFee } from "./trading/paperExchange.js";
import type { Token } from "./trading/types.js";

export type LockCfg = (typeof CFG)["lock"];

/** The lock rule's config, or null when both MM_LOCK_PCT and MM_LOCK_PX_F are off. */
export function lockCfg(cfg: typeof CFG = CFG): LockCfg | null {
  return (cfg.lock.pct != null && cfg.lock.pct > 0) || (cfg.lock.pxF != null && cfg.lock.pxF > 0) ? cfg.lock : null;
}

/** The price trigger's minimum |net| in shares: MM_LOCK_PX_MIN_NET × the order size. */
export function lockMinNet(cfg: typeof CFG = CFG): number {
  return cfg.lock.pxMinNet * cfg.orderSize;
}

/** The dollars a window must lock: MM_LOCK_PCT × the order size (shares pay $1). */
export function lockTarget(cfg: typeof CFG = CFG): number {
  return (cfg.lock.pct ?? 0) * cfg.orderSize;
}

export interface LockIn {
  now: number;
  elapsed: number;
  left: number;
  /** A live, fresh book with a spread of at most MAX_GOOD_SPREAD. */
  good: boolean;
  /** The Up book's best bid / ask. The Down ask is 1 − the Up bid. */
  bestBid: number | null;
  bestAsk: number | null;
  /** The window's holdings after merges (one of them is 0) and its cash flow so far (Account WinPos.cash). */
  up: number;
  down: number;
  cash: number;
  /** The average buy price of the Up / Down shares held (Account upCost / up); null when none are held. */
  upAvg: number | null;
  downAvg: number | null;
  /** Fills so far in the window (a window that never traded has nothing to lock). */
  fills: number;
  /** USDC not locked by working orders. */
  free: number;
  /** A take is still on its way to the book. */
  busy: boolean;
}

export interface LockOut { take: Take | null; stop: string | null; steps: Step[] }

const EPS = 1e-9, MIN_USD = 1, RETRY_MS = 300;
const c = (x: number) => (x * 100).toFixed(1) + "¢";
const usd = (x: number) => (x >= 0 ? "+$" : "−$") + Math.abs(x).toFixed(2);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const tok = (t: Token) => (t === "UP" ? "Up" : "Down");

/** One window's lock: once it fires the window stops (makers off) for good; it keeps closing what is left. */
export class Lock {
  /** Why the window stopped (null = still market making). */
  stopped: string | null = null;
  /** Lock takes sent this window. */
  sent = 0;
  private last: number | null = null;
  /** The token the lock buys in this window (set by its first take). */
  private token: Token | null = null;

  constructor(private readonly cfg: LockCfg, private readonly target: number, private readonly minNetSh = 0, private readonly minUsd = MIN_USD) {}

  decide(x: LockIn): LockOut {
    const g = this.cfg, steps: Step[] = [], P = this.target;
    const usdOn = g.pct != null && g.pct > 0, pxOn = g.pxF != null && g.pxF > 0;
    const out = (v: string, s: Step["s"] = "info", take: Take | null = null): LockOut => { steps.push({ k: "lock", v, s }); return { take, stop: this.stopped, steps }; };
    if (!x.fills) return out("no fills yet", "ok");
    const net = x.up - x.down, n = Math.abs(net);
    if (n < 0.5) {
      // flat: what the window ends with is its cash flow, whichever side wins
      if (!this.stopped && usdOn && x.cash >= P - EPS) this.stopped = `lock: flat with ${usd(x.cash)} locked (≥ $${P.toFixed(2)}): market making stopped for the window`;
      return out(this.stopped ?? (usdOn ? `flat, ${usd(x.cash)} locked (needs $${P.toFixed(2)})` : "flat"), this.stopped ? "warn" : "ok");
    }
    // already ≥ P if the held token loses (cash alone): nothing to buy, the held shares are a free option
    if (usdOn && x.cash >= P - EPS) {
      this.stopped ??= `lock: ${usd(x.cash)} locked with ${+n.toFixed(2)} ${tok(net > 0 ? "UP" : "DOWN")} still held (≥ $${P.toFixed(2)}): market making stopped for the window`;
      return out(this.stopped, "warn");
    }
    const t: Token = net > 0 ? "DOWN" : "UP";
    // one token a window: what the $1 minimum over-bought is kept, never bought back
    if (this.token && t !== this.token) return out(`the ${tok(net > 0 ? "UP" : "DOWN")} the lock bought over |net| is kept`, "ok");
    if (x.elapsed < g.fromSec) return out(`opening: from ${g.fromSec}s`, "off");
    if (x.left < g.untilLeftSec) return out(`closing: none in the last ${g.untilLeftSec}s`, "off");
    if (!x.good || x.bestBid == null || x.bestAsk == null) return out("no good book", "off");
    if (x.busy) return out("a take is on its way to the book");
    if (this.last != null && x.now - this.last < RETRY_MS) return out("just sent");
    const ask = t === "UP" ? x.bestAsk : r4(1 - x.bestBid);
    if (ask <= EPS || ask > g.maxPx + EPS) return out(`the ${tok(t)} ask ${c(ask)} is outside 0–${c(g.maxPx)}`, "off");
    const lim = r4(Math.min(g.maxPx, ask + g.slip));
    // the venue's $1 minimum: at a low ask |net| may cost less, so buy the shares $1 pays for (the extra pays if it wins)
    const q = Math.max(n, Math.ceil((this.minUsd - EPS) / ask));
    const cost = q * (lim + takerFee(lim));
    const locked = x.cash - cost + n;
    const usdHit = usdOn && locked >= P - EPS;
    // the price trigger: the short ask against the held token's average buy price; once the lock fired (this.token) it
    // keeps closing what is left, under the minimum |net| too
    const p = net > 0 ? x.upAvg : x.downAvg;
    const pxT = pxOn && p != null && p < 1 ? r4((1 - p) * (1 - g.pxF!)) : null;
    const pxHit = !usdHit && pxT != null && ask <= pxT + EPS && (n >= this.minNetSh - EPS || this.token != null);
    if (!usdHit && !pxHit) {
      const why = [usdOn ? `locks ${usd(locked)} (needs $${P.toFixed(2)})` : null,
        pxT != null ? `the ${tok(t)} ask ${c(ask)} (price lock ≤ ${c(pxT)}${n < this.minNetSh - EPS ? `, needs |net| ≥ ${+this.minNetSh.toFixed(2)}` : ""})` : null];
      return out(`net ${net > 0 ? "+" : ""}${+net.toFixed(2)} · buying ${+q.toFixed(2)} ${tok(t)} at ${c(lim)} ${why.filter(Boolean).join(" · ")}`, "ok");
    }
    if (cost > x.free + EPS) return out(`locks ${usd(locked)} but costs $${cost.toFixed(2)}, free $${x.free.toFixed(2)}`, "warn");
    this.last = x.now; this.sent++; this.token = t;
    const held = tok(net > 0 ? "UP" : "DOWN");
    this.stopped ??= usdHit ? `lock: ${usd(locked)} locked (≥ $${P.toFixed(2)}): market making stopped for the window`
      : `lock (price): ${held} bought at ${c(p!)} avg, the ${tok(t)} ask ${c(ask)} ≤ ${c(pxT!)}: market making stopped for the window`;
    const msg = `buy ${+q.toFixed(2)} ${tok(t)} up to ${c(lim)} (ask ${c(ask)}) ` + (usdHit ? `locks ${usd(locked)} ≥ $${P.toFixed(2)}`
      : `price lock: ask ≤ ${c(pxT!)} = (1 − ${c(p!)}) × ${+(1 - g.pxF!).toFixed(2)}, locks ${usd(locked)}`) +
      (q > n + EPS ? ` (${+n.toFixed(2)} raised to the $${this.minUsd} minimum)` : "");
    const spend = Math.max(this.minUsd, Math.ceil(q * ask * 100 - 1e-6) / 100);
    return out(msg, "warn", { token: t, price: lim, size: q, kind: "lock", why: `lock ${msg}`, usd: spend });
  }
}
