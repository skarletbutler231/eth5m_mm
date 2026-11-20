// "Does the fair value predict the market?" — measured live, three ways, all from sums so windows
// aggregate exactly.
//   lead   at h = 1 s and 5 s: gap g = FV(t) - mid(t), move d = mid(t+h) - mid(t), on good-book
//          samples at both ends. corr(g, d), slope beta = cov/var(g), and the hit rate of
//          sign(g) == sign(d) when |g| >= 1c and the mid moved. A model with information the book has
//          not priced yet scores hit > 50% and beta > 0. ⚠ A noisy mid that snaps back also scores here,
//          so read it with the settlement score.
//   track  mean |FV - mid| in cents.
//   settle once a second: Brier and log loss of FV and of the mid against the outcome. This is the
//          information test: FV < market on both = FV knows more than the book did.
//   fvb    the same FV priced with a Binance-only nowcast, alongside the blended one (lead, track, and a
//          paired settlement score on the seconds where both exist): did adding Coinbase help?
export interface LeadAcc { n: number; sg: number; sd: number; sgg: number; sdd: number; sgd: number; hitN: number; hitK: number }
export interface SettleAcc {
  n: number; bFv: number; bFva: number; bMkt: number; lFv: number; lFva: number; lMkt: number;
  pn: number; pFv: number; pFvb: number; plFv: number; plFvb: number;   // paired: blended vs Binance-only FV
}
export interface Score {
  lead: { fv1: LeadAcc; fv5: LeadAcc; fva1: LeadAcc; fva5: LeadAcc; fvb1: LeadAcc; fvb5: LeadAcc };
  mae: { n: number; fv: number; fva: number; nb: number; fvB: number; fvb: number };
  settle: SettleAcc;
}
const LEADS = ["fv1", "fv5", "fva1", "fva5", "fvb1", "fvb5"] as const;

const lead0 = (): LeadAcc => ({ n: 0, sg: 0, sd: 0, sgg: 0, sdd: 0, sgd: 0, hitN: 0, hitK: 0 });
export const emptyScore = (): Score => ({
  lead: { fv1: lead0(), fv5: lead0(), fva1: lead0(), fva5: lead0(), fvb1: lead0(), fvb5: lead0() },
  mae: { n: 0, fv: 0, fva: 0, nb: 0, fvB: 0, fvb: 0 },
  settle: { n: 0, bFv: 0, bFva: 0, bMkt: 0, lFv: 0, lFva: 0, lMkt: 0, pn: 0, pFv: 0, pFvb: 0, plFv: 0, plFvb: 0 },
});

export function addLead(a: LeadAcc, g: number, d: number): void {
  a.n++; a.sg += g; a.sd += d; a.sgg += g * g; a.sdd += d * d; a.sgd += g * d;
  if (Math.abs(g) >= 0.01 && d !== 0) { a.hitN++; if (Math.sign(g) === Math.sign(d)) a.hitK++; }
}

const LL = (p: number, y: number) => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); };
export function addSettle(a: SettleAcc, fv: number, fva: number, mid: number, up: boolean, fvb: number | null = null): void {
  const y = up ? 1 : 0;
  a.n++;
  a.bFv += (fv - y) ** 2; a.bFva += (fva - y) ** 2; a.bMkt += (mid - y) ** 2;
  a.lFv += LL(fv, y); a.lFva += LL(fva, y); a.lMkt += LL(mid, y);
  if (fvb != null) { a.pn++; a.pFv += (fv - y) ** 2; a.pFvb += (fvb - y) ** 2; a.plFv += LL(fv, y); a.plFvb += LL(fvb, y); }
}

export function mergeScore(into: Score, s: Score | undefined | null): Score {
  if (!s) return into;
  for (const k of LEADS) for (const f of Object.keys(into.lead[k]) as (keyof LeadAcc)[]) into.lead[k][f] += s.lead?.[k]?.[f] ?? 0;
  for (const f of Object.keys(into.mae) as (keyof Score["mae"])[]) into.mae[f] += s.mae?.[f] ?? 0;
  for (const f of Object.keys(into.settle) as (keyof SettleAcc)[]) into.settle[f] += s.settle?.[f] ?? 0;
  return into;
}

export interface LeadSummary { n: number; corr: number | null; beta: number | null; hit: number | null; hitN: number }
export interface ScoreSummary {
  windows?: number;
  lead: { fv1: LeadSummary; fv5: LeadSummary; fva1: LeadSummary; fva5: LeadSummary; fvb1: LeadSummary; fvb5: LeadSummary };
  maeFv: number | null; maeFva: number | null;
  /** mean |FV − mid| and |Binance-only FV − mid| on the same samples (cents) */
  maePair: { n: number; fv: number | null; fvb: number | null };
  settle: { n: number; brierFv: number | null; brierFva: number | null; brierMkt: number | null; llFv: number | null; llFva: number | null; llMkt: number | null };
  /** blended vs Binance-only FV on the same seconds */
  pair: { n: number; brierFv: number | null; brierFvb: number | null; llFv: number | null; llFvb: number | null };
}

function leadSum(a: LeadAcc): LeadSummary {
  const vg = a.n * a.sgg - a.sg * a.sg, vd = a.n * a.sdd - a.sd * a.sd, c = a.n * a.sgd - a.sg * a.sd;
  return {
    n: a.n,
    corr: a.n > 10 && vg > 0 && vd > 0 ? c / Math.sqrt(vg * vd) : null,
    beta: a.n > 10 && vg > 0 ? c / vg : null,
    hit: a.hitN ? a.hitK / a.hitN : null, hitN: a.hitN,
  };
}

export function summarize(raw: Score, windows?: number): ScoreSummary {
  const s = mergeScore(emptyScore(), raw);   // archived scores from before a field existed read as zeros
  const n = s.settle.n, k = (x: number) => (n ? x / n : null);
  const pn = s.settle.pn, p = (x: number) => (pn ? x / pn : null);
  return {
    windows,
    lead: { fv1: leadSum(s.lead.fv1), fv5: leadSum(s.lead.fv5), fva1: leadSum(s.lead.fva1), fva5: leadSum(s.lead.fva5), fvb1: leadSum(s.lead.fvb1), fvb5: leadSum(s.lead.fvb5) },
    maeFv: s.mae.n ? (100 * s.mae.fv) / s.mae.n : null,
    maeFva: s.mae.n ? (100 * s.mae.fva) / s.mae.n : null,
    maePair: { n: s.mae.nb, fv: s.mae.nb ? (100 * s.mae.fvB) / s.mae.nb : null, fvb: s.mae.nb ? (100 * s.mae.fvb) / s.mae.nb : null },
    settle: { n, brierFv: k(s.settle.bFv), brierFva: k(s.settle.bFva), brierMkt: k(s.settle.bMkt), llFv: k(s.settle.lFv), llFva: k(s.settle.lFva), llMkt: k(s.settle.lMkt) },
    pair: { n: pn, brierFv: p(s.settle.pFv), brierFvb: p(s.settle.pFvb), llFv: p(s.settle.plFv), llFvb: p(s.settle.plFvb) },
  };
}
