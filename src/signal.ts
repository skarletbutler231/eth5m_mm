// MOVE SIGNAL — a big, fast move of the quoter's target quote, pushed to other bots on WS /signal (server.ts).
// The target centres on mid + FLOW_FV_SCALE × the flow FV's predicted 2 s mid move (Binance perp, book imbalance), so a
// jump in it usually comes before the Up book moves (README "Move signal", 2026-10-14):
//   archive, 139 windows of 100 ms frames: a ≥ 3¢ target move in 100 ms, the book not moved yet and the forecast on its
//     side, was followed by the Up mid moving the same way within 500 ms 82% of the time (4% the other way), +4.2¢;
//   this detector live (10 ms steps, 8 windows): 37 a window, 86% / 2%, the first same-way book change a median 100 ms on.
// The lead is short: a taker order filled 200 ms after the signal about broke even after the fee (+0.5¢ a share on the
// archive, −0.3¢ live), and at 300 ms it lost.
//
// The detector compares the target now with the target lookbackMs ago, side by side (a side present both times), on
// every quote the engine makes: the 100 ms frame and, in "+10ms" windows, every decide step between frames. So it fires
// on the first step the move crosses the threshold. It skips:
//   - a re-centring: when the Up spread widens past 3¢ the flow FV switches off and the target centres on the anchored
//     FV, a jump that is no market news; both quotes must centre on the same source;
//   - with leadOnly (default): a move the book made too (the mid changed over the lookback: the target only followed
//     it), or one the flow forecast does not point to. Without it the live hit rate was 77% / 12%. leadMode "excess"
//     (the pair trade's PAIR_LEAD) lets the book move the target's way, as long as the target moved at least minMove
//     more than its mid; a mid that moved the other way still holds the move back;
//   - with minPred and top (defaults 3.5¢ and 1/3): a move the flow forecast backs by less than 3.5¢, or by less than the
//     strongest third of the last 100 moves found. The cut rises with volatility, so the feed sends about a third of what
//     it found in any hour; 92-93% of those went the same way within 500 ms, 0-1% the other way (config.ts).
// The move is the average of the two sides' moves. The post-only rule holds a side a tick off the other side of the book
// (the target bid under the best ask), so in a fast move toward the book that side stays put and the move counts half:
// the bid 50 → 29¢ with the ask held at 52¢ reads −10.5¢. measure "free" (the pair trade's PAIR_MOVE) counts only the
// sides free of that hold at both ends of the lookback (both sides when neither or no side was held).
// Prices are in Up terms: the target ask is the Up ask (it goes out as a Down bid at 1 − ask). dir "up" = the Up token
// should rise (buy Up), "down" = it should fall (buy Down).
//
// A second detector, "fast" (CFG.fastSignal), runs beside it on WS /signal-fast: the pair's detector with a 100 ms lookback
// (config.ts). Its messages are the same with "signal": "fast" added; /signal's carry no name.
// WS /signal-pair carries the pair trade's own detector (pairTrader.ts, the PAIR_* rules), "signal": "pair": every signal it
// fires, the ones the pair trade then skips included. Only a pair app (PAIR_TRADE=on, paper or live) has one; elsewhere
// the feed only heartbeats, not armed.
import { CFG } from "./config.js";

export type SignalCfg = typeof CFG.signal;
/** What leadOnly counts as a lead. unmoved: the book mid did not move over the lookback. excess: it was still or moved
 *  the target's way, and the target moved at least minMove more than it. */
export type LeadMode = "unmoved" | "excess";
/** How the target's move is measured. both: the average of the two sides. free: of the sides the post-only rule did not
 *  hold at either end of the lookback (both sides when that leaves none). */
export type MoveMeasure = "both" | "free";

/** The move feeds and their WS paths: each its own detector, its signals archived with the window under its key. */
export const FEEDS = {
  signal: { path: "/signal", archive: "signals" },
  fast: { path: "/signal-fast", archive: "fastSignals" },
  pair: { path: "/signal-pair", archive: "pairSignals" },
} as const;
export type Feed = keyof typeof FEEDS;

/** One quote of the engine (a frame or a decide step). */
export interface SigSample {
  now: number;
  win: number; slug: string; up: string; down: string;
  elapsed: number; left: number;
  /** The quoter's target, Up price (null = no target on that side). */
  bid: number | null; ask: number | null;
  /** The sides the post-only rule held a tick off the book (quoter.ts Quote.held). Missing = neither. */
  held?: { bid: boolean; ask: boolean };
  /** The Up book's best bid / ask. */
  bb: number | null; ba: number | null;
  /** What the target centred on, and the flow FV's predicted 2 s mid move in ¢ (null off the flow FV). */
  centre: number | null; centerSrc: string; pred: number | null;
  step: "frame" | "decide";
}

export interface MoveMsg {
  type: "move";
  /** The detector's name, on the named ones only ("fast" on /signal-fast). */
  signal?: string;
  /** Counts the signals since the bot started. */
  seq: number;
  /** Detection time, ms since the epoch on this box's clock. */
  t: number;
  win: number; slug: string;
  /** Token ids: the one to buy is `up` on dir "up", `down` on dir "down". */
  up: string; down: string;
  dir: "up" | "down";
  /** Target move over lookbackMs, Up price units (signed: +0.03 = 3¢ up). */
  move: number;
  lookbackMs: number;
  target: { bid: number | null; ask: number | null; bid0: number | null; ask0: number | null };
  /** The Up book now; move = its mid's change over the same lookback (null when it was not two-sided both times). */
  book: { bid: number | null; ask: number | null; mid: number | null; move: number | null };
  /** The signal is ahead of the market: the book mid had not moved yet (leadMode "excess": had moved at least minMove
   *  less than the target, and not the other way). null = unknown. */
  lead: boolean | null;
  centre: number | null; centerSrc: string;
  /** The flow FV's predicted 2 s mid move, Up price units. */
  pred: number | null;
  elapsed: number; left: number;
  step: "frame" | "decide";
}

const r4 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
/** top: the forecasts of the last TOP_N moves found set the cut, once there are TOP_MIN of them (the floor alone before). */
const TOP_N = 100, TOP_MIN = 20;

export class MoveSignal {
  private hist: { t: number; bid: number | null; ask: number | null; mid: number | null; src: string; hb: boolean; ha: boolean }[] = [];
  private win = -1;
  private fired = { up: -Infinity, down: -Infinity };
  private seq = 0;
  /** top: the forecasts (on the move's side, price units) of the moves found lately. */
  private cands: number[] = [];
  private last: { t: number; win: number; slug: string; ready: boolean } | null = null;

  /** name: tags every message (none on /signal, so its messages stay as they were). */
  constructor(readonly cfg: SignalCfg & { leadMode?: LeadMode; measure?: MoveMeasure }, readonly name?: string) {}

  /** One quote; the signal it fires, if any. */
  sample(x: SigSample): MoveMsg | null {
    if (x.win !== this.win) { this.win = x.win; this.hist = []; this.fired = { up: -Infinity, down: -Infinity }; }
    this.last = { t: x.now, win: x.win, slug: x.slug, ready: (x.bid != null || x.ask != null) && (!this.cfg.leadOnly || x.pred != null) };
    if (this.cfg.minMove == null) return null;
    const L = this.cfg.lookbackMs;
    const mid = x.bb != null && x.ba != null ? (x.bb + x.ba) / 2 : null;
    const h = this.hist;
    h.push({ t: x.now, bid: x.bid, ask: x.ask, mid, src: x.centerSrc, hb: !!x.held?.bid, ha: !!x.held?.ask });
    // keep one sample at or before now − L, the reference; older ones go
    while (h.length > 1 && h[1].t <= x.now - L) h.shift();
    const ref = h[0];
    // no reference yet, or the steps stalled (a move over twice the lookback is not this signal)
    if (ref.t > x.now - L || ref.t < x.now - 2 * L || ref.src !== x.centerSrc) return null;
    const both: number[] = [], free: number[] = [];
    if (x.bid != null && ref.bid != null) { both.push(x.bid - ref.bid); if (!x.held?.bid && !ref.hb) free.push(x.bid - ref.bid); }
    if (x.ask != null && ref.ask != null) { both.push(x.ask - ref.ask); if (!x.held?.ask && !ref.ha) free.push(x.ask - ref.ask); }
    if (!both.length) return null;
    const d = this.cfg.measure === "free" && free.length ? free : both;
    const move = d.reduce((a, b) => a + b, 0) / d.length;
    if (Math.abs(move) < this.cfg.minMove - 1e-9) return null;
    const dir = move > 0 ? "up" : "down";
    if (x.now - this.fired[dir] < this.cfg.cooldownMs) return null;
    const bookMove = mid != null && ref.mid != null ? mid - ref.mid : null;
    const along = bookMove == null ? null : bookMove * Math.sign(move);     // the mid's move the target's way
    const lead = along == null ? null
      : this.cfg.leadMode === "excess" ? along > -1e-9 && Math.abs(move) - along >= this.cfg.minMove - 1e-9
      : Math.abs(along) < 1e-9;
    if (this.cfg.leadOnly && (!lead || x.pred == null || x.pred * move <= 0)) return null;
    // a move is judged once, at its first step: the cooldown runs whether it goes out or not. (Judged at every step, a weak
    // move whose forecast grew a few steps on got out anyway: the 10 ms replay kept 59% of the moves, not a third.)
    this.fired[dir] = x.now;
    if (this.cfg.minPred != null || this.cfg.top != null) {
      // the forecast's backing: at least the floor, and in the strongest `top` of the moves found lately
      const fc = x.pred == null ? null : (x.pred / 100) * Math.sign(move), cut = this.cut();
      if (this.cfg.top != null && fc != null) {
        this.cands.push(fc);
        if (this.cands.length > TOP_N) this.cands.shift();
      }
      if (fc == null || fc < cut - 1e-9) return null;
    }
    return {
      type: "move", ...(this.name ? { signal: this.name } : {}), seq: ++this.seq, t: x.now, win: x.win, slug: x.slug, up: x.up, down: x.down,
      dir, move: r4(move)!, lookbackMs: L,
      target: { bid: x.bid, ask: x.ask, bid0: ref.bid, ask0: ref.ask },
      book: { bid: x.bb, ask: x.ba, mid: r4(mid), move: r4(bookMove) },
      lead,
      centre: r4(x.centre), centerSrc: x.centerSrc, pred: x.pred == null ? null : r4(x.pred / 100),
      elapsed: Math.round(x.elapsed * 100) / 100, left: Math.round(x.left * 100) / 100, step: x.step,
    };
  }

  /** The forecast a move needs now: the floor, raised to the strongest `top` of the moves found lately. */
  cut(): number {
    let c = this.cfg.minPred ?? -Infinity;
    if (this.cfg.top != null && this.cands.length >= TOP_MIN) {
      const s = [...this.cands].sort((a, b) => a - b);
      c = Math.max(c, s[Math.min(s.length - 1, Math.floor((1 - this.cfg.top) * s.length))]);
    }
    return c;
  }

  /** For the heartbeat: armed = a move could fire now (a target was quoted in the last second, with the flow forecast
   *  that leadOnly needs); cut = the forecast a move needs now (null = none). */
  state(now: number) {
    const l = this.last, c = this.cut();
    return { ...(this.name ? { signal: this.name } : {}), win: l?.win ?? null, slug: l?.slug ?? null, armed: this.cfg.minMove != null && !!l && now - l.t < 1000 && l.ready,
      cut: Number.isFinite(c) ? r4(c) : null };
  }
}

// FILL SIGNAL — WS /signal-fills (2026-11-11, the user's idea: the hedge bot follows the bot's good maker fills).
// One "fill" message the moment this bot's own maker order fills, for the kinds FILL_SIGNAL names (config.ts):
//   nocancel  the order was resting with no cancel sent (Fill.cxl false);
//   race      a race cancel was in flight when it filled (Fill.cxl true, Fill.cxlWhy "race").
// Default: the live app sends nocancel, the paper app nocancel and race. Run 9 (11-10 18:09–23:55 UTC, 69 windows), the
// Up mid's move in the fill's favour at 5 s / 30 s / 1 m: live no cancel +2.0 / +1.3 / +8.1¢ (14 fills), paper no cancel
// +2.4 / +2.1 / +2.5¢ (99), paper race −0.8 / +4.1 / +7.6¢ (36). Those are from the maker's price: a taker following the
// signal pays the ask and the fee on top.
// Its own path, so /signal's subscribers see nothing new. Same hello / hb frame as the move feeds. Takes never signal.
export const FILL_FEED = { path: "/signal-fills" } as const;
export type FillKind = "nocancel" | "race";

export interface FillMsg {
  type: "fill";
  signal: "fills";
  /** Counts the fill signals since the bot started. */
  seq: number;
  /** When the signal went out and when the fill happened (paper: the taker's print heard; live: the user channel's
   *  message heard), ms since the epoch on this box's clock. */
  t: number; tFill: number;
  /** Which bot filled: its mode and its setup name (MM_TAG, else the window tag). */
  bot: "paper" | "shadow" | "live"; name: string;
  kind: FillKind;
  win: number; slug: string;
  /** Token ids. The bot bought `token` (the id), which is `up` on dir "up" and `down` on dir "down": to follow it, buy that one. */
  up: string; down: string;
  dir: "up" | "down"; token: string;
  /** The fill: price paid for that token, the same in Up terms, shares, order id. */
  price: number; upPrice: number; size: number; oid: number;
  /** Time on the book before the fill, and the shares ahead of it when it went live. */
  restMs: number; queue0: number;
  /** The Up book and the model FV (Up terms) at the signal. */
  book: { bid: number | null; ask: number | null; mid: number | null };
  fv: number | null;
  elapsed: number; left: number;
}
