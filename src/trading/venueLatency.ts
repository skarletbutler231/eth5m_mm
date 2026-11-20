// VENUE LATENCY — the sweep fill model's place and cancel times drawn from live orders (PAPER_SWEEP_LAT=live|busy, the
// default since 2026-10-23), in place of the constants PAPER_SWEEP_PLACE_MS / PAPER_SWEEP_CANCEL_MS (README "Venue latency
// from live orders" and "Paper vs live, 5 windows").
//
// The tables (2026-10-23): one-way ms to the venue, quantiles 0, 2.5, …, 100% of the live market maker's own 3,034 orders
// of 04:36–05:04 UTC (data-live; tools/fillcal/mmlat.py rebuilds them from a live archive).
//   place   the venue's own event time of the placement − the send (the timing line's "placed v+N").
//   cancel  the cancel's HTTP answer − its send − ANSWER_MS. A cancel goes out once the post's answer has brought the
//           venue's order id, so its send is at the answer at the earliest.
//   CALM    orders sent (cancelled) more than 1 s from any moment a sweep filled one of ours: 2,467 places, 2,469 cancels.
//           Median 29 / 26 ms, p90 88 / 82, 10% over 100 ms.
//   SWEPT   orders that did NOT fill, sent (cancelled) within 150 ms of such a moment: 112 places, 79 cancels. Median
//           83 / 70 ms, p90 149 / 137, a third over 100 ms. Not selected by their own fill, so this is the venue being
//           slow when a taker sweep arrives, not slow cancels getting filled. It fades over the next second (46 / 50 ms
//           at 150–500 ms, 34 / 31 at 500–1000 ms).
//   No price move predicts it here: a ≥ 6¢ target move in 200 ms (the detector below) marked 13% of sends busy at a
//   median 63 / 62 ms, and Binance moves of ≥ 1 bps in 1 s were 2% of sends. The orders that filled had slow times
//   (cancel median 75 ms, place 78) because they were sent into sweeps.
// Before 2026-10-23 the tables were the live pair app's 1,515 maker bids of 10-14/15, each sent on a ≥ 6¢ move (place
// median 113, p90 794; cancel 61, p90 390), with calm = those × PAPER_SWEEP_LAT_CALM.
//
// How a draw resolves: every order keeps the QUANTILE u of its place and cancel draws (Order.placeU / cancelU) and the
// time is the table's value at u, calm or swept, at the moment it matters:
//   · the ack and the order manager's "off the venue" time use the state at the send (busy after a detector move or a
//     sweep that reached our price, else calm);
//   · the race against a taker (paperExchange.ts sweepPrint) uses the SWEPT table when the order's send or cancel was
//     within SWEPT_NEAR_MS of that taker's arrival, as measured: the sweep makes the venue slow for the orders around it.
// One venue state for all orders: z(t), a standard normal Ornstein-Uhlenbeck process with time constant tauMs (2 s);
// every draw at time t is the table's quantile Φ(z(t)), so orders sent together get the same time. Live, consecutive
// sends 0–100 ms apart correlated 0.80 (log), 100–1000 ms 0.55, 1–5 s 0.28; a post and its cancel ~0.5 s later 0.69.

import { normCdf } from "../model/math.js";

/** A take's (fill-and-kill market BUY) send → the venue's answer, ms, quantiles 0, 2.5, …, 100% (41 points): the live
 *  market maker's 73 excess takes of $1 or more of 11-03 and 11-04 (runs 3 and 4; the timing line's "answer +N"; the
 *  ~30 ms answers were the $1-minimum refusals and are left out). Median 348, p10 242, p90 947, never under 185: the
 *  venue holds a take before matching it. Used as the send → match time (PAPER_TAKE_MS=live), so a few ms late. */
export const LIVE_TAKE_MS = [185, 204, 223, 235, 242, 250, 260, 265, 269, 271, 274, 281, 282, 286, 308, 313, 324, 329, 334, 343, 348, 352, 380,
  406, 429, 431, 460, 484, 496, 507, 607, 673, 742, 776, 839, 875, 947, 1205, 1341, 1998, 2842];

/** A take's send → match drawn from LIVE_TAKE_MS at quantile u (uniform 0–1), interpolated. */
export function liveTakeMs(u: number): number {
  const x = Math.min(1, Math.max(0, u)) * (LIVE_TAKE_MS.length - 1), i = Math.floor(x), f = x - i;
  return i >= LIVE_TAKE_MS.length - 1 ? LIVE_TAKE_MS[LIVE_TAKE_MS.length - 1] : LIVE_TAKE_MS[i] + f * (LIVE_TAKE_MS[i + 1] - LIVE_TAKE_MS[i]);
}

/** One-way ms, quantiles 0, 2.5, …, 100% (41 points). Calm: more than 1 s from a sweep that filled us. */
export const CALM_PLACE_MS = [18, 20, 21, 21, 22, 22, 23, 23, 24, 24, 24, 25, 25, 26, 26, 26, 27, 27, 28, 28, 29, 29, 30, 30, 31, 32, 34, 35, 37, 39,
  42, 45, 51, 56, 63, 74, 88, 108, 150, 296, 1929];
export const CALM_CANCEL_MS = [15, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 23, 24, 24, 25, 25, 26, 26, 27, 28, 28, 29, 30, 31, 33, 34, 37,
  39, 44, 48, 53, 61, 70, 82, 105, 146, 313, 1753];
/** Swept: unfilled orders sent / cancelled within SWEPT_NEAR_MS of a sweep that filled one of ours. */
export const SWEPT_PLACE_MS = [22, 27, 31, 32, 35, 38, 41, 45, 54, 57, 60, 61, 62, 65, 69, 70, 71, 73, 76, 81, 83, 84, 87, 91, 93, 97, 98, 102, 109,
  114, 120, 123, 126, 129, 138, 142, 149, 199, 219, 284, 412];
/** Swept cancels since 2026-11-03 (tools/fillcal/sweptcancel.py): the live twins of 155 paper fills that lost the cancel
 *  race, live 11:50–14:10 UTC (the same token and price, placed within 300 ms). That is the population the race resolves
 *  against this table, selected on the paper's draw, not the live one. Median 32, p90 77 (the 10-23 table, unfilled orders
 *  near our own fill moments, n 79: 70 / 137; it made the paper fill 163 of the orders both bots sent where live filled 12). */
export const SWEPT_CANCEL_MS = [17, 18, 18, 19, 21, 21, 22, 22, 23, 23, 24, 24, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 35, 36, 38, 41, 43, 45, 47,
  51, 53, 56, 60, 62, 64, 73, 77, 80, 92, 108, 653];
/** The 10-23 swept cancel table (before 2026-11-03), for replays of the older paper record: PAPER_SWEPT_CANCEL=1023. */
export const SWEPT_CANCEL_MS_1023 = [16, 22, 25, 27, 31, 33, 37, 37, 44, 51, 53, 53, 54, 55, 59, 60, 62, 64, 67, 70, 70, 73, 74, 75, 76, 77, 79, 80, 83,
  90, 92, 98, 103, 106, 110, 113, 136, 142, 192, 224, 341];
/** A NEW-BEST post (a bid above the best bid, or for a Down bid an Up-terms ask under the best ask, on the book at the send):
 *  send → the venue's placement, ms, quantiles 0, 2.5, …, 100% (41 points), one table whatever the busy state
 *  (PAPER_NEWBEST_LAT). Both tables are live twins: the live order with the same token and price sent within 300 ms of the
 *  paper order. The time is the venue's placement stamp where the live order rested; where it never did (the early cancel
 *  beat the post, or post-only refused it as crossing), it is the first copy's refusal answer − ANSWER_MS.
 *
 *  COPIES3 (default since 2026-11-09 ~21:40 UTC). Live with LIVE_POST_COPIES=3, 09:30–21:25 UTC 11-09, 143 windows.
 *  - Twins of the paper orders that were new best at the send on the frame book, the class paperExchange.ts applies the
 *    table to: 1,452 of 3,777. Median 97, p75 161, p90 332, p99 1,400; 27% never placed.
 *  - Live's own new-best posts agree: 2,606 of them, 105 / 327.
 *  - The same class in runs 5–7 without copies was 78 / 542: copies cut the tail, not the median (different hours).
 *
 *  TWIN288 (2026-11-09 morning, tag "+nb"). Measured on a narrower class: twins of the paper orders that still improved the
 *  best at paper's ack (43 ms later), runs 5–7, 1,498 twins: median 288, p90 1,128. Applied to every new-best-at-send post,
 *  it was too strict: that class ran 78 / 542 in the same runs.
 *
 *  Fills (09:30–21:25 UTC, paper on TWIN288): new-best twins filled paper 25 of 1,452, live 8. So paper's maker fills
 *  stay generous beyond the latency (scratchpad postlat/nbtab.py of that session). */
export const COPIES3_NEWBEST_PLACE_MS = [16, 22, 24, 28, 33, 39, 45, 51, 55, 58, 62, 65, 67, 72, 76, 80, 82, 85, 88, 92, 97, 100, 105, 110, 116, 122,
  129, 135, 143, 152, 161, 174, 186, 202, 237, 277, 332, 420, 542, 900, 3062];
export const TWIN_NEWBEST_PLACE_MS = [17, 28, 40, 55, 68, 82, 95, 105, 116, 126, 134, 146, 158, 171, 186, 202, 219, 233, 250, 270, 288, 307, 337,
  360, 386, 426, 465, 489, 523, 563, 605, 652, 713, 783, 874, 989, 1128, 1296, 1579, 1983, 3971];
/** Calm draws from a scaled busy table (flat test tables) never go under these. */
const FLOOR = { place: 20, cancel: 15 };
/** The post's answer comes this long after the venue placed it (median 10, p90 12 on the market maker's 2,919 live posts
 *  of 2026-10-23). Live, a cancel needs the venue's order id, so it goes out no sooner than that (liveExchange.ts
 *  sendCancel), and a cancel's answer tells the order manager the order is off the venue this long after it left. */
export const ANSWER_MS = 10;
/** An order sent or cancelled within this of a taker's arrival meets the swept tables in the race against that taker. */
export const SWEPT_NEAR_MS = 150;

export interface LatCfg {
  /** live: swept around sweeps and after big target moves, calm otherwise · busy: always swept (the pessimistic bound). */
  mode: "live" | "busy";
  /** With flat `place` / `cancel` tables and no calm ones: calm = those × this (self-test). */
  calm: number;
  /** The engine's latency detector: a target move of at least `move` (Up price units) within `lookbackMs`... */
  move: number;
  lookbackMs: number;
  /** ...keeps the venue busy this long. */
  busyMs: number;
  /** A sweep that reached one of our prices keeps the venue busy this long after the taker arrived. */
  sweptMs: number;
  tauMs: number;
  seed: number;
  /** Tables in place of the measured ones (self-test): busy / swept, and calm. */
  place?: number[];
  cancel?: number[];
  placeCalm?: number[];
  cancelCalm?: number[];
  /** "1023": the 10-23 swept cancel table is in `cancel` (PAPER_SWEPT_CANCEL; tagged +sc1023). */
  sweptCancel?: "1023";
  /** PAPER_NEWBEST_LAT: a new-best post's place time from this table (COPIES3_ / TWIN_NEWBEST_PLACE_MS), busy or calm; null
   *  = the calm / swept tables as any other post (the rule before 2026-11-09). */
  newBest?: number[] | null;
  /** Which new-best table, for the tag: "copies3" → "+nb3", "twin288" → "+nb". */
  newBestName?: "copies3" | "twin288";
}

export interface LatDraw { ms: number; busy: boolean; u: number }

export class VenueLatency {
  private z = 0;
  private zt: number | null = null;
  /** Detector moves and taker arrivals whose sweep reached our price: the venue is busy for a while after each. */
  private moves: number[] = [];
  private sweeps: number[] = [];
  private readonly rnd: () => number;

  constructor(private readonly cfg: LatCfg) {
    this.rnd = mulberry32(cfg.seed);
  }

  /** The engine's detector saw a big target move at `now`. */
  noteMove(now: number): void {
    this.moves.push(now);
    if (this.moves.length > 64) this.moves.splice(0, this.moves.length - 64);
  }

  /** A taker that arrived at the venue at `arr` swept to one of our prices (known once its print is in, ~150 ms later). */
  noteSweep(arr: number): void {
    if (this.sweeps.length && Math.abs(this.sweeps[this.sweeps.length - 1] - arr) < 1) return;
    this.sweeps.push(arr);
    if (this.sweeps.length > 64) this.sweeps.splice(0, this.sweeps.length - 64);
  }

  /** Was the venue busy at `t`: always in `busy` mode, else within busyMs after a detector move or within sweptMs after
   *  a sweep (and SWEPT_NEAR_MS before it: the sweep's own orders). */
  busyAt(t: number): boolean {
    if (this.cfg.mode === "busy") return true;
    for (const m of this.moves) if (m <= t && t < m + this.cfg.busyMs) return true;
    for (const a of this.sweeps) if (a - SWEPT_NEAR_MS <= t && t <= a + this.cfg.sweptMs) return true;
    return false;
  }

  busy(now: number): boolean { return this.busyAt(now); }

  /** PAPER_NEWBEST_LAT is on: new-best posts draw from their own table. */
  get newBestOn(): boolean { return !!this.cfg.newBest; }

  /** newBest: the post sets a new best price (PAPER_NEWBEST_LAT draws it from the new-best table). */
  place(now: number, newBest = false): LatDraw { return this.draw(now, "place", newBest); }
  cancel(now: number): LatDraw { return this.draw(now, "cancel"); }

  /** The table's value at quantile u: the new-best table for a new-best post (PAPER_NEWBEST_LAT), else the swept table when
   *  busy and the calm one otherwise. */
  at(kind: "place" | "cancel", u: number, busy: boolean, newBest = false): number {
    if (kind === "place" && newBest && this.cfg.newBest) return Math.round(quantile(this.cfg.newBest, u));
    const busyTab = kind === "place" ? this.cfg.place ?? SWEPT_PLACE_MS : this.cfg.cancel ?? SWEPT_CANCEL_MS;
    if (busy) return Math.round(quantile(busyTab, u));
    const calmTab = kind === "place" ? this.cfg.placeCalm ?? (this.cfg.place ? null : CALM_PLACE_MS) : this.cfg.cancelCalm ?? (this.cfg.cancel ? null : CALM_CANCEL_MS);
    return Math.round(calmTab ? quantile(calmTab, u) : Math.max(FLOOR[kind], quantile(busyTab, u) * this.cfg.calm));
  }

  private draw(now: number, kind: "place" | "cancel", newBest = false): LatDraw {
    const u = normCdf(this.state(now)), busy = this.busyAt(now);
    return { ms: this.at(kind, u, busy, newBest), busy, u };
  }

  /** z at `now`: the exact OU step from the last draw (the same ms = the same z). */
  private state(now: number): number {
    if (this.zt == null) this.z = this.gauss();
    else if (now !== this.zt) {
      const a = Math.exp(-Math.abs(now - this.zt) / this.cfg.tauMs);
      this.z = a * this.z + Math.sqrt(1 - a * a) * this.gauss();
    }
    this.zt = now;
    return this.z;
  }

  private gauss(): number {
    const u = Math.max(this.rnd(), 1e-12), v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** The table's value at quantile u (0–1), linear between its points. */
export function quantile(table: number[], u: number): number {
  const x = Math.min(Math.max(u, 0), 1) * (table.length - 1), i = Math.min(Math.floor(x), table.length - 2);
  return table[i] + (x - i) * (table[i + 1] - table[i]);
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
