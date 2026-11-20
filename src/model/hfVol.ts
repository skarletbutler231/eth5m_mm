// BASE SIGMA: blend of two EWMAs of 1-second Binance log-return variance (half-lives 2 min and 30 min).
//
// Chosen 2026-10-07 on 7 days / 2,011 windows of recorded Polymarket quotes against the market's own
// implied vol (κ fitted on the first half, everything scored on the second half):
//                         mean |FV - mid|   FV log loss   window-to-window sd of ln(implied/est)
//   HAR-RV on 1-min       6.37c             0.5925        0.96     <- pmqb's sigma: whipsaws on the last minute
//   EWMA 1 s, 5 min       4.93c             0.5368        0.51
//   blend 2 min + 30 min  4.69c (90-290 s)  best overall
// The fast leg follows bursts inside a window; the slow leg keeps one quiet minute from collapsing sigma.
export class HfVol {
  private vF: number | null = null;
  private vS: number | null = null;
  private lastSec = -1;
  private lastPx = 0;

  constructor(private readonly hFast: number, private readonly hSlow: number, private readonly wFast: number) {}

  /** Warm both EWMAs from a run of 1 s prices: initialise at their mean squared return, then roll. */
  seed(points: { sec: number; px: number }[]): number {
    const pts = points.filter((p) => p.px > 0).sort((a, b) => a.sec - b.sec);
    if (pts.length < 120) return 0;
    let s = 0, n = 0;
    for (let i = 1; i < pts.length; i++) {
      const g = pts[i].sec - pts[i - 1].sec;
      if (g <= 0 || g > 600) continue;
      s += Math.log(pts[i].px / pts[i - 1].px) ** 2 / g; n++;
    }
    if (!n) return 0;
    this.vF = this.vS = s / n;
    this.lastSec = pts[0].sec; this.lastPx = pts[0].px;
    for (const p of pts.slice(1)) this.update(p.sec, p.px);
    return pts.length;
  }

  /** Feed the mid holding at each whole second. Gaps are spread evenly over the missing seconds. */
  update(sec: number, px: number): void {
    if (!(px > 0)) return;
    if (this.lastSec < 0 || sec - this.lastSec > 600) { this.lastSec = sec; this.lastPx = px; return; }
    if (sec <= this.lastSec) return;
    const gap = sec - this.lastSec;
    const r2 = Math.log(px / this.lastPx) ** 2 / gap;
    const roll = (v: number | null, h: number) => { const lam = Math.pow(2, -gap / h); return v == null ? r2 : lam * v + (1 - lam) * r2; };
    this.vF = roll(this.vF, this.hFast);
    this.vS = roll(this.vS, this.hSlow);
    this.lastSec = sec; this.lastPx = px;
  }

  /** sigma per sqrt(second), or null before any data. */
  sigma(): number | null {
    if (this.vF == null || this.vS == null) return null;
    return Math.sqrt(this.wFast * this.vF + (1 - this.wFast) * this.vS);
  }
  parts(): { fast: number | null; slow: number | null } {
    return { fast: this.vF == null ? null : Math.sqrt(this.vF), slow: this.vS == null ? null : Math.sqrt(this.vS) };
  }
}
