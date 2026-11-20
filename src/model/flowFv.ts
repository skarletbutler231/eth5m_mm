// FLOW FV: the quote centre from order flow. A LightGBM model (gbm.ts) predicts the Up mid's move over the next
// H s (H = 2) from the Up book, its order flow, the tape, Binance spot and perp, and the Binance-only anchored pricer;
// the centre is mid + FLOW_FV_SCALE × that prediction.
//
// Why (2026-10-12, README "Flow FV"): on pmqb's L2 record the mid's next 0.5 / 1 / 2 s is predictable (out-of-sample
// R² 32 / 21 / 12%; the anchored lead alone 1.3%), mostly from the Binance perp's last 250-500 ms move and book
// imbalance. Replayed through this bot's v4 code on 10-05..10-11 (2,013 windows), quoting around mid + 2 × the 2 s
// prediction lost $3.84 a window against $11.14 for the anchored FV (+$7.30, 7/7 days), and the same predictions
// shuffled across windows gained only $1.56.
//
// The features reproduce the offline panel (tools/flowfv: l2panel.py + l2lib.features) definition by definition, in
// this bot's receive clock. Book and tape state is kept per token from the first update seen (the next window's
// books join 20 s before its open), frame lags are looked up by time in a per-window history, and the pricer
// inputs come from the Binance-only anchored FV, as the model was trained on.
import type { Level } from "../feeds/pmBook.js";
import type { PriceBuffer } from "./priceBuffer.js";
import { normCdf, normInv } from "./math.js";
import { Gbm } from "./gbm.js";

const GOOD_SPREAD = 0.03 + 1e-9;
const LAGS = [100, 500, 1000, 3000, 10000] as const;
const BR = [100, 250, 500, 1000, 2000, 5000, 10000, 30000] as const;
const UR = [100, 250, 500, 1000, 5000] as const;
const ix = (p: number) => Math.round(p * 1000);          // the offline book's 0.1¢ grid
const pdf = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
const clip = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Top of one book after an update: best prices (null = side empty) and their sizes. */
export interface Top { bb: number | null; bs: number; ba: number | null; as: number }

interface TokState {
  // Cont–Kukanov–Stoikov OFI, one step per book update (a message / a same-ms group), and touch changes
  cofi: number; nch: number; pbb: number | null; pba: number | null; pbs: number; pas: number;
  // tape: cumulative taker-signed size in this token's own terms, print count, last print
  cum: number; cnt: number; last: { p: number; s: number; t: number; seq: number } | null;
  seen: number;
}

interface Hist { t: number; cofi: number; cflow: number; cn: number; nch: number; mid: number }

/** What the engine (or a replay) hands the module each frame. */
export interface FlowIn {
  now: number;
  startTs: number;
  up: string; down: string;
  bids: Level[]; asks: Level[];             // the Up book, best first, at least 5¢ deep
  /** The Binance-only anchored pricer (fairValueAnchored on venuePath(Binance)); null when it could not price. */
  fv: number | null; m: number | null; sd: number | null; tau: number | null; nowcast: number | null;
  cl: number | null; clStamp: number | null; // last Chainlink print and its observation stamp
  sigBase: number | null;                   // per sqrt s (log units)
  kappa: number;
  spot: PriceBuffer | null; perp: PriceBuffer | null;   // null = feed stale: its returns go missing
}

export interface FlowOut {
  /** Predicted mid move over the model's horizon, in cents (null when the book is not good or the model is off). */
  pred: number | null;
  /** mid + scale × pred, clipped to 0.1-99.9¢; null when pred is. */
  centre: number | null;
  mid: number | null;
  good: boolean;
  x: Float64Array | null;
  /** Features missing this frame (NaN): a dead feed shows up here first. */
  nNaN: number;
}

export class FlowFv {
  readonly names: string[];
  private toks = new Map<string, TokState>();
  private seq = 0;
  // per window
  private win = -1;
  private hist: Hist[] = [];
  private prevMid = NaN; private midChangeT = 0;
  private anchor: { z: number; sd: number; m: number; mid: number; t: number } | null = null;

  constructor(readonly model: Gbm | null, readonly scale: number) {
    this.names = model?.features ?? [];
  }

  private tok(id: string): TokState {
    let s = this.toks.get(id);
    if (!s) {
      s = { cofi: 0, nch: 0, pbb: null, pba: null, pbs: 0, pas: 0, cum: 0, cnt: 0, last: null, seen: Date.now() };
      this.toks.set(id, s);
      if (this.toks.size > 12) {   // tokens of windows long gone
        const old = [...this.toks.entries()].sort((a, b) => a[1].seen - b[1].seen).slice(0, this.toks.size - 12);
        for (const [k] of old) this.toks.delete(k);
      }
    }
    return s;
  }

  /** After one update of a token's book (a socket message, or one same-ms group in a replay): the OFI step. */
  onBook(token: string, top: Top): void {
    const s = this.tok(token);
    const cbs = top.bb != null ? top.bs : 0, cas = top.ba != null ? top.as : 0;
    if (s.pbb != null && s.pba != null && top.bb != null && top.ba != null) {
      const bb = ix(top.bb), ba = ix(top.ba), pbb = ix(s.pbb), pba = ix(s.pba);
      let e = 0;
      if (bb >= pbb) e += cbs;
      if (bb <= pbb) e -= s.pbs;
      if (ba <= pba) e -= cas;
      if (ba >= pba) e += s.pas;
      s.cofi += e;
    }
    const k = (p: number | null) => (p == null ? null : ix(p));
    if (k(top.bb) !== k(s.pbb) || k(top.ba) !== k(s.pba)) s.nch++;
    s.pbb = top.bb; s.pba = top.ba; s.pbs = cbs; s.pas = cas;
  }

  /** A trade print on a token (side = the taker's). */
  onPrint(token: string, price: number, size: number, side: string, rx: number): void {
    if (!(size > 0) || !Number.isFinite(price)) return;
    const s = this.tok(token), sg = side === "BUY" ? 1 : -1;
    s.cum += sg * size; s.cnt++; s.last = { p: price, s: sg, t: rx, seq: ++this.seq };
  }

  /** frame() between frames (MM_DECIDE_STEP_MS): the same features and prediction at x.now, leaving the per-window
   *  state (frame history, last mid change, anchor) as the last frame left it, so the frames' features are unchanged. */
  peek(x: FlowIn): FlowOut {
    const H = this.hist.slice(), pm = this.prevMid, mc = this.midChangeT, an = this.anchor, w = this.win;
    try { return this.frame(x); }
    finally { this.hist = H; this.prevMid = pm; this.midChangeT = mc; this.anchor = an; this.win = w; }
  }

  frame(x: FlowIn): FlowOut {
    const { now } = x;
    if (x.startTs !== this.win) { this.win = x.startTs; this.hist = []; this.prevMid = NaN; this.midChangeT = now; this.anchor = null; }
    const U = this.tok(x.up), Dn = this.tok(x.down);
    U.seen = Dn.seen = now;
    const bb = x.bids.length ? x.bids[0][0] : null, ba = x.asks.length ? x.asks[0][0] : null;
    const bs1 = bb != null ? x.bids[0][1] : 0, as1 = ba != null ? x.asks[0][1] : 0;
    let bd2 = 0, bd5 = 0, ad2 = 0, ad5 = 0;
    if (bb != null) { const b = ix(bb); for (const [p, s] of x.bids) { const q = ix(p); if (q < b - 50) break; bd5 += s; if (q >= b - 19) bd2 += s; } }
    if (ba != null) { const a = ix(ba); for (const [p, s] of x.asks) { const q = ix(p); if (q > a + 50) break; ad5 += s; if (q <= a + 19) ad2 += s; } }
    const mid = bb != null && ba != null ? (bb + ba) / 2 : NaN;
    const good = bb != null && ba != null && ba - bb <= GOOD_SPREAD && mid > 0.005 && mid < 0.995;

    // tape in Up terms: an Up print as is, a Down print at 1 − p with the taker's side flipped
    const cflow = U.cum - Dn.cum, cn = U.cnt + Dn.cnt;
    const lu = U.last, ld = Dn.last;
    const lt = lu && (!ld || lu.seq > ld.seq) ? { p: lu.p, s: lu.s, t: lu.t } : ld ? { p: 1 - ld.p, s: -ld.s, t: ld.t } : null;

    // frame history (this window) for the lagged differences; the mid's last change
    if (!(mid === this.prevMid)) this.midChangeT = now;   // NaN counts as a change, as offline
    this.prevMid = mid;
    const h: Hist = { t: now, cofi: U.cofi, cflow, cn, nch: U.nch, mid };
    this.hist.push(h);
    while (this.hist.length && this.hist[0].t < now - 10_600) this.hist.shift();
    const back = (ms: number): Hist | null => {
      for (let i = this.hist.length - 2; i >= 0; i--) if (this.hist[i].t <= now - ms + 30) return this.hist[i].t >= now - ms - 70 ? this.hist[i] : null;
      return null;
    };

    // the Binance-only anchored FV: anchor on a good mid that differs from the anchor's
    const sd = x.sd, m = x.m;
    let fva = NaN;
    if (sd != null && m != null && Number.isFinite(sd) && sd > 0) {
      if (good && (!this.anchor || this.anchor.mid !== mid)) this.anchor = { z: normInv(clip(mid, 1e-6, 1 - 1e-6)), sd, m, mid, t: now };
      if (this.anchor) fva = normCdf((this.anchor.z * this.anchor.sd + (m - this.anchor.m)) / sd);
    }

    if (!this.model) return { pred: null, centre: null, mid: Number.isFinite(mid) ? mid : null, good, x: null, nNaN: 0 };
    const F: Record<string, number> = {};
    F.mid = mid; F.el = now / 1000 - x.startTs; F.tau = x.tau ?? NaN; F.spr = bb != null && ba != null ? (ba - bb) * 100 : NaN;
    const fv = x.fv ?? NaN;
    F.lead_a = (fva - mid) * 100; F.lead = (fv - mid) * 100;
    F.anc_age = this.anchor ? Math.round((now - this.anchor.t) / 100) * 0.1 : NaN;
    const zmid = normInv(clip(mid, 1e-4, 1 - 1e-4));
    F.zmid = Number.isFinite(mid) ? zmid : NaN;
    F.z = Number.isFinite(fv) ? normInv(clip(fv, 1e-9, 1 - 1e-9)) : NaN;
    const delta = sd != null && sd > 0 && Number.isFinite(mid) ? (pdf(zmid) / sd) * 1e-2 : NaN;
    F.delta = delta;
    const mp = (bb! * as1 + ba! * bs1) / (bs1 + as1);
    F.mpd = (mp - mid) * 100;
    const imb = (a: number, b: number) => (a - b) / Math.max(a + b, 1e-9);
    F.imb1 = imb(bs1, as1); F.imb2 = imb(bd2, ad2); F.imb5 = imb(bd5, ad5);
    F.lbs1 = Math.log1p(bs1); F.las1 = Math.log1p(as1); F.lbd5 = Math.log1p(bd5); F.lad5 = Math.log1p(ad5);
    for (const L of LAGS) {
      const o = back(L);
      F[`ofi${L}`] = o ? h.cofi - o.cofi : NaN;
      F[`tf${L}`] = o ? h.cflow - o.cflow : NaN;
      F[`tn${L}`] = o ? h.cn - o.cn : NaN;
      F[`dmid${L}`] = o ? (h.mid - o.mid) * 100 : NaN;
      F[`nch${L}`] = o ? h.nch - o.nch : NaN;
    }
    F.lastd = lt ? (lt.p - mid) * 100 : NaN; F.lastsg = lt ? lt.s : 0; F.lastage = lt ? now - lt.t : now + 1;
    F.midage = Math.round((now - this.midChangeT) / 100) * 0.1;
    const ret = (b: PriceBuffer | null, ms: number) => {
      const a = b?.at(now), c = b?.at(now - ms);
      return a != null && c != null ? Math.log(a / c) * 1e4 : NaN;
    };
    for (const L of BR) F[`br${L}`] = ret(x.spot, L);
    for (const L of UR) F[`ur${L}`] = ret(x.perp, L);
    for (const L of [250, 500, 1000, 2000, 5000]) F[`bdc${L}`] = delta * F[`br${L}`];
    for (const L of [250, 500, 1000]) F[`udc${L}`] = delta * F[`ur${L}`];
    F.nc_gap = x.nowcast != null && x.cl != null ? Math.log(x.nowcast / x.cl) * 1e4 : NaN;
    F.ncdc = delta * F.nc_gap;
    F.clage = x.clStamp != null ? now - x.clStamp : NaN;
    F.sig = x.sigBase != null ? x.sigBase * 1e4 : NaN;
    F.m = m != null ? m * 1e4 : NaN;
    F.kappa = x.kappa;

    const v = new Float64Array(this.names.length);
    let nNaN = 0;
    for (let i = 0; i < this.names.length; i++) { const f = F[this.names[i]]; v[i] = f === undefined || !Number.isFinite(f) ? NaN : f; if (Number.isNaN(v[i])) nNaN++; }
    if (!good) return { pred: null, centre: null, mid: Number.isFinite(mid) ? mid : null, good, x: v, nNaN };
    const pred = this.model.predict(v);
    return { pred, centre: clip(mid + (this.scale * pred) / 100, 0.001, 0.999), mid, good, x: v, nNaN };
  }
}
