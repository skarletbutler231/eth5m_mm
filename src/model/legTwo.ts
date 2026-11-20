// The leg-2 model (README "Leg-2 model"; tools/l2model): at the pair trade's leg-1 fill, P(the Up mid moves against leg 1
// over the next 5 s). A LightGBM classifier run by gbm.ts (its sum is the log-odds) on features read from the window's
// 100 ms rows (engine.ts COLS), exactly as tools/l2model/feat.py computes them for training: every value is signed so that
// + is the signal's way, and read from the last row at or before the time asked (a missing value carries the last one
// before it). The self-test checks both against Python's vectors (models/l2-h5.vectors.json).
import { Gbm } from "./gbm.js";

type Row = readonly (number | null)[];

const WIN_SEC = 300;
const MID_L = [0.5, 1, 2, 5, 10, 30], PATH_L = [1, 5, 30], PERP_L = [0.1, 0.5, 1, 2, 5, 10], CB_L = [0.5, 1, 2, 5], BIN_L = [0.5, 2], PPATH_L = [5, 30];
const k = (L: number) => String(L).replace(".", "p");

/** The model's inputs, in its order (tools/l2model/feat.py FEATURES). */
export const L2_FEATURES: readonly string[] = [
  "move", "tok_ask", "s_pred", "s_gap", "s_mid_5", "s_mid_30", "pre", "preperp", "over",
  "mid", "tok_mid", "spread", "gap", "gap_1", "gap_5", "pred", "pred_avg1", "fvgap", "fvagap", "fv_10", "dist", "distz", "basis", "left",
  ...MID_L.map((L) => `mid_${k(L)}`), ...PATH_L.map((L) => `path_${k(L)}`), ...PERP_L.map((L) => `perp_${k(L)}`),
  ...CB_L.map((L) => `cb_${k(L)}`), ...BIN_L.map((L) => `bin_${k(L)}`), ...PPATH_L.map((L) => `pperp_${k(L)}`),
];

/** log(a / b) in basis points; NaN unless both are positive. */
const lr = (a: number, b: number) => (a > 0 && b > 0 ? Math.log(a / b) * 1e4 : NaN);

class RowView {
  private readonly c: Record<string, number>;
  constructor(private readonly r: readonly Row[], cols: readonly string[]) {
    this.c = Object.fromEntries(cols.map((n, i) => [n, i]));
    for (const n of ["el", "cl", "fv", "fva", "bb", "ba", "cmid", "bmid", "ffv", "fpred", "umid"]) if (!(n in this.c)) throw new Error(`rows lack ${n}`);
  }
  /** Last row at or before t (−1: none). */
  idx(t: number): number {
    const r = this.r, e = this.c.el;
    let lo = 0, hi = r.length;                                   // first row after t + 1e-6
    while (lo < hi) { const m = (lo + hi) >> 1; if ((r[m][e] as number) <= t + 1e-6) lo = m + 1; else hi = m; }
    return lo - 1;
  }
  at(i: number, col: string): number { const v = this.r[i][this.c[col]]; return v == null ? NaN : v; }
  /** The column's last value at or before row i (NaN: none). */
  last(col: string, i: number): number {
    const c = this.c[col];
    for (; i >= 0; i--) { const v = this.r[i][c]; if (v != null) return v; }
    return NaN;
  }
  /** The Up book's mid: the last row at or before i with both sides. */
  mid(i: number): number {
    const b = this.c.bb, a = this.c.ba;
    for (; i >= 0; i--) { const x = this.r[i]; if (x[b] != null && x[a] != null) return ((x[b] as number) + (x[a] as number)) / 2; }
    return NaN;
  }
  /** The quote centre: the flow FV, else the anchored FV, carried forward. */
  centre(i: number): number {
    const f = this.c.ffv, a = this.c.fva;
    for (; i >= 0; i--) { const x = this.r[i]; const v = x[f] != null ? x[f] : x[a]; if (v != null) return v; }
    return NaN;
  }
  /** The flow forecast (¢) of the last row at or before i that quoted on the flow FV. */
  pred(i: number): number {
    const f = this.c.ffv, p = this.c.fpred;
    for (; i >= 0; i--) { const x = this.r[i]; if (x[f] != null && x[p] != null) return x[p] as number; }
    return NaN;
  }
  /** Was row k quoted on the flow FV with a forecast? Its forecast, else null. */
  predOf(k: number): number | null { const x = this.r[k]; return x[this.c.ffv] != null && x[this.c.fpred] != null ? (x[this.c.fpred] as number) : null; }
}

/** The inputs at the fill (L2_FEATURES order; null = no row yet). tSig / tFill: seconds into the window; sg +1 for an up
 *  signal, −1 down; move = |target move|; tokAsk = leg 1's token ask at the signal; Kcl = the strike (null: unknown). */
export function l2Features(rows: readonly Row[], cols: readonly string[], tSig: number, tFill: number, sg: 1 | -1, move: number, tokAsk: number, Kcl: number | null): number[] | null {
  const R = new RowView(rows, cols);
  const i = R.idx(tFill), i0 = R.idx(tSig);
  if (i < 0 || i0 < 0) return null;
  const f: Record<string, number> = {};
  const m = R.mid(i), m0 = R.mid(i0);
  const back = (L: number) => Math.max(R.idx(tFill - L), 0);
  // the signal
  f.move = move; f.tok_ask = tokAsk;
  f.s_pred = R.pred(i0) / 100 * sg;
  f.s_gap = (R.centre(i0) - m0) * sg;
  f.s_mid_5 = (m0 - R.mid(Math.max(R.idx(tSig - 5), 0))) * sg;
  f.s_mid_30 = (m0 - R.mid(Math.max(R.idx(tSig - 30), 0))) * sg;
  // from the signal to the fill
  f.pre = (m - m0) * sg;
  f.preperp = lr(R.last("umid", i), R.last("umid", i0)) * sg;
  f.over = f.pre - move;
  // the book and the fair values at the fill
  f.mid = m;
  f.tok_mid = sg > 0 ? m : 1 - m;
  f.spread = R.at(i, "ba") - R.at(i, "bb");
  f.gap = (R.centre(i) - m) * sg;
  const j1 = back(1), j5 = back(5);
  f.gap_1 = (R.centre(j1) - R.mid(j1)) * sg;
  f.gap_5 = (R.centre(j5) - R.mid(j5)) * sg;
  f.pred = R.pred(i) / 100 * sg;
  let ps = 0, pn = 0;
  for (let q = j1; q <= i; q++) { const v = R.predOf(q); if (v != null) { ps += v; pn++; } }
  f.pred_avg1 = pn ? ps / pn / 100 * sg : NaN;
  f.fvgap = (R.last("fv", i) - m) * sg;
  f.fvagap = (R.last("fva", i) - m) * sg;
  f.fv_10 = (R.last("fv", i) - R.last("fv", back(10))) * sg;
  const left = WIN_SEC - tFill;
  f.dist = Kcl ? (R.last("cl", i) - Kcl) / Kcl * 1e4 * sg : NaN;
  f.distz = f.dist / Math.sqrt(Math.max(left, 1));
  f.basis = lr(R.last("umid", i), R.last("bmid", i)) * sg;
  f.left = left;
  // lookbacks
  for (const L of MID_L) f[`mid_${k(L)}`] = (m - R.mid(back(L))) * sg;
  for (const L of PATH_L) {
    let s = 0, prev = R.mid(back(L));
    for (let q = back(L) + 1; q <= i; q++) { const v = R.mid(q), d = Math.abs(v - prev); s += Number.isNaN(d) ? 0 : d; prev = v; }
    f[`path_${k(L)}`] = s;
  }
  for (const [name, col, Ls] of [["perp", "umid", PERP_L], ["cb", "cmid", CB_L], ["bin", "bmid", BIN_L]] as const)
    for (const L of Ls) f[`${name}_${k(L)}`] = lr(R.last(col, i), R.last(col, back(L))) * sg;
  for (const L of PPATH_L) {
    let s = 0, prev = R.last("umid", back(L));
    for (let q = back(L) + 1; q <= i; q++) { const v = R.last("umid", q), d = Math.abs(lr(v, prev)); s += Number.isNaN(d) ? 0 : d; prev = v; }
    f[`pperp_${k(L)}`] = s;
  }
  return L2_FEATURES.map((n) => f[n]);
}

export class LegTwoModel {
  constructor(readonly gbm: Gbm) {
    if (gbm.features.join() !== L2_FEATURES.join()) throw new Error("leg-2 model: its features are not legTwo.ts's (retrain or update both)");
  }
  static load(file: string): LegTwoModel { return new LegTwoModel(Gbm.load(file)); }
  /** P(against) for an input vector. */
  prob(x: ArrayLike<number>): number { return 1 / (1 + Math.exp(-this.gbm.predict(x))); }
}
