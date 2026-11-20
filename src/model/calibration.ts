// Live calibration of the free inputs, each from data the bot is already receiving.
//
// kappa  sigma_implied / sigma_base. On tradeable seconds 90-290 s before the close the market's
//        price inverts to an implied vol: m / sqrt(sigma^2 tau_eff + eps^2) = Phi^-1(mid). One median
//        per completed window; kappa = median of the last KAPPA_WINDOWS of them (prior padded to 3).
//        Only COMPLETED windows feed it, so the current window's FV never learns from its own mid.
//        Replayed on 7 days, this rolling rule matched a kappa fitted in hindsight.
// eps^2  error of rebuilding the settlement TWAP from the relayed Chainlink prints: for every published
//        TWAP report at stamp T, e = ln(twap(T) / time-weighted mean of the prints over [T - D, T]).
//        Probe 2026-10-07: sd 0.04 bps, no bias. Floored at EPS_FLOOR_BPS.
// basis  ln(Chainlink TWAP / Binance mean over the same window): only used to ESTIMATE the price to
//        beat for a window the bot joined after its open.
// lag    argmin over L of the variance of first differences of ln(chainlink spot(T)) -
//        ln(binance(T - L)). Probe 2026-10-07: minimum at ~250 ms (Chainlink stamps are ~0.25 s behind
//        Binance's receive clock; the 2 s figure in pmqb was receive-time lag, not stamp lag).
// blend  the nowcast's Coinbase weight w and the two lags of the blended path (fairValue.blendPath):
//        argmin over (L_b, L_c, w) of the variance of Δln chainlink − (1−w)·Δln binance(T − L_b) −
//        w·Δln coinbase(T − L_c) over consecutive prints (fitBlend; w is closed-form per lag pair). One fit
//        a minute on the last 10 min, each value the median of the last 15 fits (prior-padded to 3). Replayed on the
//        2026-10-09 hour, this rolling rule gave w 0.23-0.31 and an 18% lower nowcast error on the
//        following 2 min than the Binance-only lag fit.
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../config.js";
import { median } from "./math.js";
import type { PriceBuffer } from "./priceBuffer.js";

/** Bump when the definition of sigma_base changes: a kappa measured against another sigma is meaningless. */
export const SIGMA_MODEL = "ewma1s-blend";

interface Persisted {
  sigmaModel?: string;
  kappaHist: { startTs: number; med: number; n: number }[];
  eps2: number | null; epsN: number;
  lagHist: number[];
  blendHist?: BlendFit[];
  savedAt: number;
}

export interface BlendFit { lb: number; lc: number; w: number; n: number }

const BLEND_LAGS = Array.from({ length: 31 }, (_, i) => i * 50);   // 0-1500 ms

/**
 * The (Binance lag, Coinbase lag, Coinbase weight) that best maps Chainlink's print-to-print moves.
 * `fixW` / `fixLc` pin those. Null with fewer than 300 usable print pairs.
 */
export function fitBlend(ticks: { t: number; v: number }[], bin: PriceBuffer, cb: PriceBuffer,
                         fixW: number | null = null, fixLc: number | null = null): BlendFit | null {
  const lcs = fixLc != null ? [fixLc] : BLEND_LAGS;
  const y: number[] = [], db: number[][] = BLEND_LAGS.map(() => []), dc: number[][] = lcs.map(() => []);
  const move = (buf: PriceBuffer, a: number, b: number, l: number) => { const u = buf.at(b - l), v = buf.at(a - l); return u == null || v == null ? null : Math.log(u / v); };
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1].t, b = ticks[i].t;
    if (b - a > 1500) continue;
    const mb = BLEND_LAGS.map((l) => move(bin, a, b, l)), mc = lcs.map((l) => move(cb, a, b, l));
    if (mb.includes(null) || mc.includes(null)) continue;
    y.push(Math.log(ticks[i].v / ticks[i - 1].v));
    mb.forEach((x, k) => db[k].push(x!)); mc.forEach((x, k) => dc[k].push(x!));
  }
  const n = y.length;
  if (n < 300) return null;
  let best: BlendFit & { r: number } = { lb: 0, lc: 0, w: 0, n, r: Infinity };
  for (let i = 0; i < BLEND_LAGS.length; i++) {
    const u = y.map((v, k) => v - db[i][k]);                       // what Binance leaves unexplained
    let mu = 0; for (const x of u) mu += x; mu /= n;
    for (let j = 0; j < lcs.length; j++) {
      // var(u − w·d), d = Coinbase move − Binance move: minimised at w = cov(u, d) / var(d)
      let md = 0; for (let k = 0; k < n; k++) md += dc[j][k] - db[i][k]; md /= n;
      let cv = 0, vd = 0, vu = 0;
      for (let k = 0; k < n; k++) { const du = u[k] - mu, dd = dc[j][k] - db[i][k] - md; cv += du * dd; vd += dd * dd; vu += du * du; }
      const w = fixW ?? Math.max(0, Math.min(1, vd > 0 ? cv / vd : 0));
      const r = (vu - 2 * w * cv + w * w * vd) / n;
      if (r < best.r) best = { lb: BLEND_LAGS[i], lc: lcs[j], w, n, r };
    }
  }
  return { lb: best.lb, lc: best.lc, w: Math.round(best.w * 1000) / 1000, n };
}

export class Calibrator {
  private file: string;
  kappaHist: Persisted["kappaHist"] = [];
  kappa = CFG.kappaPrior;
  eps2 = (CFG.epsPriorBps * 1e-4) ** 2;
  epsN = 0;
  epsSrc: "prior" | "live" | "saved" = "prior";
  lagHist: number[] = [];
  lagMs = CFG.oracleLagPriorMs;
  lagFixed = false;
  /** The nowcast blend: Coinbase weight, Binance lag inside the blend, Coinbase lag. */
  blendHist: BlendFit[] = [];
  cbW = CFG.cbWeightPrior;
  cbLagMs = CFG.cbLagPriorMs;
  blendLagB = CFG.oracleLagPriorMs;
  cbWFixed: number | null = null;
  cbLagFixed: number | null = null;
  basis: number | null = null;          // EWMA of r, log units (Chainlink below Binance => negative)
  private recon: Record<30 | 60, Map<number, number>> = { 30: new Map(), 60: new Map() };

  constructor(private readonly log: (m: string) => void) {
    this.file = path.join(CFG.dataDir, "calib.json");
    if (CFG.oracleLag !== "auto" && Number.isFinite(Number(CFG.oracleLag))) {
      this.lagFixed = true; this.lagMs = Number(CFG.oracleLag);
    }
    const fw = Number(CFG.cbWeight), fl = Number(CFG.cbLag);
    if (CFG.cbWeight !== "auto" && Number.isFinite(fw)) this.cbWFixed = Math.max(0, Math.min(1, fw));
    if (CFG.cbLag !== "auto" && Number.isFinite(fl)) this.cbLagFixed = Math.max(0, fl);
    this.blendLagB = this.lagMs;
    try {
      const p = JSON.parse(fs.readFileSync(this.file, "utf8")) as Persisted;
      this.kappaHist = p.sigmaModel === SIGMA_MODEL ? (p.kappaHist ?? []) : [];
      if (p.sigmaModel === SIGMA_MODEL && p.eps2 != null && p.eps2 > 0) { this.eps2 = p.eps2; this.epsN = p.epsN; this.epsSrc = "saved"; }
      if (!this.lagFixed && p.lagHist?.length) this.lagHist = p.lagHist;
      if (p.blendHist?.length) this.blendHist = p.blendHist;
      this.recompute();
      this.log(`[calib] loaded: kappa ${this.kappa.toFixed(3)} (${this.kappaHist.length} windows), eps ${(Math.sqrt(this.eps2) * 1e4).toFixed(2)} bps, lag ${this.lagMs} ms, ` +
        `nowcast Coinbase weight ${this.cbW.toFixed(2)} (Binance ${this.blendLagB} ms / Coinbase ${this.cbLagMs} ms, ${this.blendHist.length} fits)`);
    } catch { this.recompute(); /* first run: priors, and any pinned value */ }
  }

  private recompute(): void {
    const meds = this.kappaHist.slice(-CFG.kappaWindows).map((k) => k.med);
    while (meds.length < 3) meds.push(CFG.kappaPrior);
    this.kappa = median(meds) ?? CFG.kappaPrior;
    if (!this.lagFixed && this.lagHist.length) this.lagMs = Math.round(median(this.lagHist.slice(-15)) ?? this.lagMs);
    // like kappa, the prior is padded in to 3 entries, so one noisy early fit cannot move the blend alone
    const h = this.blendHist.slice(-15);
    while (h.length < 3) h.push({ lb: this.lagMs, lc: CFG.cbLagPriorMs, w: CFG.cbWeightPrior, n: 0 });
    this.cbW = median(h.map((f) => f.w))!;
    this.blendLagB = Math.round(median(h.map((f) => f.lb))!);
    this.cbLagMs = Math.round(median(h.map((f) => f.lc))!);
    if (this.cbWFixed != null) this.cbW = this.cbWFixed;
    if (this.cbLagFixed != null) this.cbLagMs = this.cbLagFixed;
  }

  save(): void {
    const p: Persisted = { sigmaModel: SIGMA_MODEL, kappaHist: this.kappaHist.slice(-200), eps2: this.epsSrc === "prior" ? null : this.eps2, epsN: this.epsN, lagHist: this.lagHist.slice(-30), blendHist: this.blendHist.slice(-30), savedAt: Date.now() };
    try { fs.mkdirSync(CFG.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(p)); } catch (e) { this.log(`[calib] save failed: ${(e as Error).message}`); }
  }

  /** A completed window's implied/base ratios. Needs 20+ samples to count. */
  closeWindow(startTs: number, ratios: number[]): number | null {
    const med = median(ratios);
    if (med == null || ratios.length < 20) return null;
    this.kappaHist.push({ startTs, med, n: ratios.length });
    this.recompute();
    this.save();
    return med;
  }

  noteTwap(w: 30 | 60, sec: number, v: number, bin: PriceBuffer, spot: PriceBuffer): void {
    const T = sec * 1000;
    // reconstruction error of the settlement average from the relayed prints
    const sf = spot.firstTs();
    if (sf != null && sf <= T - w * 1000) {
      const sm = spot.mean(T - w * 1000, T);
      if (sm != null) {
        const ring = this.recon[w];
        ring.set(sec, Math.log(v / sm));
        if (ring.size > 2 * 3600 + 60) { const cut = sec - 2 * 3600; for (const k of ring.keys()) if (k < cut) ring.delete(k); }
      }
    }
    // basis vs Binance, for estimating a missed strike
    if (w !== 60) return;
    const b1 = T - this.lagMs, b0 = b1 - w * 1000;
    const bf = bin.firstTs();
    if (bf == null || bf > b0) return;
    const m = bin.mean(b0, b1);
    if (m == null) return;
    const r = Math.log(v / m);
    this.basis = this.basis == null ? r : this.basis + 0.02 * (r - this.basis);
  }

  updateEps(w: 30 | 60 = 60): void {
    const e = [...this.recon[w].values()];
    if (e.length < 120) return;
    const med = median(e)!;
    const mad = median(e.map((x) => Math.abs(x - med)))! * 1.4826;
    const cap = Math.max(5 * mad, 1e-7);
    const ms = e.reduce((s, x) => s + Math.min(cap, Math.abs(x)) ** 2, 0) / e.length;
    this.eps2 = Math.max(ms, (CFG.epsFloorBps * 1e-4) ** 2);
    this.epsN = e.length; this.epsSrc = "live";
    this.save();
  }

  updateLag(spot: PriceBuffer, bin: PriceBuffer): void {
    if (this.lagFixed) return;
    const now = Date.now();
    const ticks = spot.slice(now - 10 * 60_000, now);
    if (ticks.length < 120) return;
    let best = { L: this.lagMs, s: Infinity };
    for (let L = 0; L <= 3000; L += 50) {
      const e: number[] = [];
      for (const k of ticks) { const b = bin.at(k.t - L); if (b != null) e.push(Math.log(k.v / b)); }
      if (e.length < 100) continue;
      let s = 0, s2 = 0;
      for (let i = 1; i < e.length; i++) { const x = e[i] - e[i - 1]; s += x; s2 += x * x; }
      const n = e.length - 1, v = s2 / n - (s / n) ** 2;
      if (v < best.s) best = { L, s: v };
    }
    if (!Number.isFinite(best.s)) return;
    this.lagHist.push(best.L);
    if (this.lagHist.length > 30) this.lagHist.shift();
    this.recompute();
    this.save();
  }

  /** Refit the nowcast blend on the last 10 min of prints (once a minute). */
  updateBlend(spot: PriceBuffer, bin: PriceBuffer, cb: PriceBuffer): BlendFit | null {
    if (this.cbWFixed === 0) return null;
    const now = Date.now();
    const f = fitBlend(spot.slice(now - 10 * 60_000, now), bin, cb, this.cbWFixed, this.cbLagFixed);
    if (!f) return null;
    this.blendHist.push(f);
    if (this.blendHist.length > 30) this.blendHist.shift();
    this.recompute();
    this.save();
    return f;
  }
}
