// FAIR VALUE of the Up token — an average-price (Asian) digital on Chainlink, nowcast with Binance and Coinbase.
//
// Settlement (Gamma cryptoMarketConfig): UP iff A >= K, where A is Chainlink BTC/USD's D-second TWAP
// at the close (D = 60 today) and K the same TWAP at the open (the price to beat).
//
// ANCHORED PRICER (primary). Work in Chainlink prices and Chainlink observation time:
//   c, t_c   last Chainlink spot print and its stamp (RTDS relays it ~1.6 s after the stamp)
//   P(s)     the venue path on Chainlink's stamp clock (StampPath): a venue's price as received at s - L,
//            L the oracle lag (~250 ms). Binance alone, or the geometric blend of Binance and Coinbase,
//            each at its own lag: P(s) = B(s - L_b)^(1-w) * C(s - L_c)^w (blendPath).
//   S_hat    nowcast for stamp now + lead = c * P(now + lead) / P(t_c)
//            (Chainlink's exact level, plus the venue move since that print)
//   known    the part of the averaging window [T_end - D, T_end] already observed:
//              Chainlink prints integrated up to t_c, then the venue-mapped path up to now + lead
//   tau      seconds of the averaging window still after now + lead
//   tau >= D   m = ln(S_hat/K)                        var = sigma^2 (tau - 2D/3)
//   0<tau<D    EA = (known + tau*S_hat)/D, m=ln(EA/K)  var = sigma^2 tau^3/(3 D^2) * (S_hat/EA)^2
//   tau <= 0   m = ln(known/D / K)                     var = 0
//   FV = Phi( m / sqrt(var + eps^2) )
// Measured 2026-10-07 on 7 days of quotes: this beats a Binance-only pricer with a venue-internal
// strike in every time bucket, by most in the last minute (log loss 10-30 s left: 0.385 vs 0.506),
// because there the realised Chainlink slice is known exactly and the Binance basis drift is not.
//
// VENUE PRICER (fallback). Same algebra on Binance alone with K_v = Binance's own D-second mean at the
// open, used when the Chainlink strike or prints are missing (e.g. the bot started mid-window).
import { normCdf } from "./math.js";
import type { PriceBuffer } from "./priceBuffer.js";

export interface FvResult {
  fv: number;
  m: number;          // ln(expected settlement average / strike)
  sd: number;         // total std of ln(A/K)
  z: number;
  tau: number;        // s of the averaging window still unobserved
  tauEff: number;     // diffusion variance / sigma^2
  branch: "future" | "partial" | "done";
  realized: number;   // share of the averaging window already observed
  ea: number;         // expected settlement average
  nowcast: number;    // price the future part is centred on (Chainlink units when anchored)
  src: "anchored" | "venue";
  clAgeMs: number | null;
}

function finish(ea: number, K: number, tau: number, D: number, sigma: number, eps2: number, nowcast: number,
                src: FvResult["src"], clAgeMs: number | null): FvResult {
  let diff: number, realized: number, branch: FvResult["branch"];
  if (tau >= D) { diff = sigma * sigma * (tau - (2 * D) / 3); realized = 0; branch = "future"; }
  else if (tau > 0) { diff = ((sigma * sigma * tau ** 3) / (3 * D * D)) * (nowcast / ea) ** 2; realized = 1 - tau / D; branch = "partial"; }
  else { diff = 0; realized = 1; branch = "done"; }
  const m = Math.log(ea / K);
  const sd = Math.sqrt(Math.max(diff + eps2, 1e-18));
  return { fv: normCdf(m / sd), m, sd, z: m / sd, tau, tauEff: diff / (sigma * sigma), branch, realized, ea, nowcast, src, clAgeMs };
}

/** A venue price mapped onto Chainlink's stamp clock. */
export interface StampPath {
  /** ms of stamps past now that the path already covers: the known part of the average runs to now + lead. */
  lead: number;
  /** Price at stamp s; past the newest data each venue holds its last value. */
  at(s: number): number | null;
  /** Integral over stamps [a, b] in price*seconds; null when a is not covered. */
  integralSec(a: number, b: number): number | null;
}

/** One venue: stamp s is the venue as received at s - lag. */
export function venuePath(buf: PriceBuffer, lag: number): StampPath {
  return { lead: lag, at: (s) => buf.at(s - lag), integralSec: (a, b) => buf.integralSec(a - lag, b - lag) };
}

/**
 * Geometric blend of two venues, each at its own lag: B(s - lagB)^(1-w) * C(s - lagC)^w. Only ratios of the
 * path are used, so the venues' basis cancels. The lead is the longer lag: the stamps between the two leads
 * ride on that venue alone while the other holds. The blend of two step functions is a step function on the
 * union of their steps, so the integral is exact.
 */
export function blendPath(b: PriceBuffer, lagB: number, c: PriceBuffer, lagC: number, w: number): StampPath {
  if (!(w > 0)) return venuePath(b, lagB);
  if (w >= 1) return venuePath(c, lagC);
  const at = (s: number) => {
    const x = b.at(s - lagB), y = c.at(s - lagC);
    return x == null || y == null ? null : Math.exp((1 - w) * Math.log(x) + w * Math.log(y));
  };
  return {
    lead: Math.max(lagB, lagC),
    at,
    integralSec(a, z) {
      if (z <= a) return 0;
      if (at(a) == null) return null;
      const steps: number[] = [];
      for (const p of b.slice(a - lagB, z - lagB)) steps.push(p.t + lagB);
      for (const p of c.slice(a - lagC, z - lagC)) steps.push(p.t + lagC);
      steps.sort((p, q) => p - q);
      let sum = 0, t0 = a, v0 = at(a)!;
      for (const t of steps) {
        if (t <= t0 || t >= z) continue;
        sum += v0 * (t - t0); t0 = t; v0 = at(t)!;
      }
      return (sum + v0 * (z - t0)) / 1000;
    },
  };
}

export interface AnchoredInput {
  now: number; K: number; endMs: number; D: number; sigma: number; eps2: number;
  path: StampPath;    // venue path on Chainlink's stamp clock (venuePath / blendPath)
  cl: PriceBuffer;    // Chainlink spot by observation stamp (ms)
}

export function fairValueAnchored(x: AnchoredInput): FvResult | null {
  const tc = x.cl.lastTs(), c = x.cl.last();
  if (tc == null || c == null || !(x.K > 0 && x.sigma > 0)) return null;
  const tk = x.now + x.path.lead;
  const S = x.path.at(tk), Sc = x.path.at(tc);
  if (S == null || Sc == null) return null;
  const k = c / Sc;
  const Sh = k * S;
  const Te = x.endMs, a = Te - x.D * 1000;
  const tau = (Te - tk) / 1000;
  let known = 0;
  if (tk > a) {
    const clEnd = Math.min(tc, Te);
    if (clEnd > a) { const r = x.cl.integralSec(a, clEnd); if (r == null) return null; known += r; }
    const bFrom = Math.max(tc, a), bTo = Math.min(tk, Te);
    if (bTo > bFrom) { const r = x.path.integralSec(bFrom, bTo); if (r == null) return null; known += k * r; }
  }
  const ea = tau >= x.D ? Sh : tau > 0 ? (known + tau * Sh) / x.D : known / x.D;
  if (!(ea > 0)) return null;
  return finish(ea, x.K, tau, x.D, x.sigma, x.eps2, Sh, "anchored", x.now - tc);
}

export function binanceStrike(buf: PriceBuffer, startMs: number, D: number, lagMs: number): number | null {
  const b = startMs - lagMs, a = b - D * 1000;
  const first = buf.firstTs();
  if (first == null || first > a) return null;
  return buf.mean(a, b);
}

export function fairValueVenue(buf: PriceBuffer, now: number, Kv: number, endMs: number, D: number, lagMs: number, sigma: number, eps2: number): FvResult | null {
  const S = buf.at(now);
  if (S == null || !(Kv > 0 && sigma > 0)) return null;
  const Te = endMs - lagMs, a = Te - D * 1000;
  const tau = (Te - now) / 1000;
  let ea: number;
  if (tau >= D) ea = S;
  else if (tau > 0) { const R = buf.integralSec(a, now); if (R == null) return null; ea = (R + tau * S) / D; }
  else { const A = buf.mean(a, Te); if (A == null) return null; ea = A; }
  return finish(ea, Kv, tau, D, sigma, eps2, S, "venue", null);
}
