// Time-indexed step series with O(log n) time-weighted integrals.
//
// The settlement quantity is a TIME-weighted mean, and venue books update at very uneven rates, so
// a plain mean of samples would over-weight bursts. Each value holds until the next one arrives
// (last-value-holds), and a running cumulative integral answers any [a, b] mean with two binary
// searches. Same semantics as pmqb's feeds/midTwap.ts, which validated this shape against
// Chainlink's own TWAP to 0.06 bps.

export class PriceBuffer {
  private ts: number[] = [];   // epoch ms, non-decreasing
  private v: number[] = [];
  private cum: number[] = [];  // integral of the step function from ts[0] to ts[i], price*ms
  private head = 0;            // logical start (compacted lazily)

  constructor(private readonly keepMs: number, private readonly coalesceMs = 0) {}

  get length(): number { return this.ts.length - this.head; }

  push(t: number, value: number): void {
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(t)) return;
    const n = this.ts.length;
    if (n > this.head) {
      const lt = this.ts[n - 1];
      if (t < lt) return;                                        // out of order: ignore
      if (t - lt <= this.coalesceMs) {                           // same instant: last value wins
        this.v[n - 1] = value;
        return;
      }
      this.cum.push(this.cum[n - 1] + this.v[n - 1] * (t - lt));
    } else {
      this.cum.push(0);
    }
    this.ts.push(t); this.v.push(value);
    this.prune(t);
  }

  private prune(now: number): void {
    const cut = now - this.keepMs;
    // keep one sample at/before the cutoff: it is the value that holds into the retained span
    let lo = this.head, hi = this.ts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.ts[mid] <= cut) lo = mid; else hi = mid - 1; }
    if (this.ts[lo] <= cut) this.head = lo;
    if (this.head > 4096 && this.head > this.ts.length / 2) {
      this.ts = this.ts.slice(this.head); this.v = this.v.slice(this.head); this.cum = this.cum.slice(this.head);
      this.head = 0;
    }
  }

  /** index of the last sample with ts <= t, or -1 */
  private idx(t: number): number {
    let lo = this.head, hi = this.ts.length - 1;
    if (hi < lo || this.ts[lo] > t) return -1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.ts[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  firstTs(): number | null { return this.length ? this.ts[this.head] : null; }
  lastTs(): number | null { return this.length ? this.ts[this.ts.length - 1] : null; }
  last(): number | null { return this.length ? this.v[this.v.length - 1] : null; }

  /** Value holding at time t, or null before the first sample. */
  at(t: number): number | null {
    const i = this.idx(t);
    return i < 0 ? null : this.v[i];
  }

  /** Cumulative integral F(t) (price*ms) from ts[0]; null before the first sample. */
  private F(t: number): number | null {
    const i = this.idx(t);
    if (i < 0) return null;
    return this.cum[i] + this.v[i] * (t - this.ts[i]);
  }

  /** Integral of the step function over [a, b] in price*seconds; null when a is not covered. */
  integralSec(a: number, b: number): number | null {
    if (b <= a) return 0;
    const fa = this.F(a), fb = this.F(b);
    if (fa == null || fb == null) return null;
    return (fb - fa) / 1000;
  }

  /** Time-weighted mean over [a, b]; null unless the buffer covers a. */
  mean(a: number, b: number): number | null {
    if (b <= a) return this.at(b);
    const s = this.integralSec(a, b);
    return s == null ? null : (s * 1000) / (b - a);
  }

  /** Samples in [a, b] (for estimators). */
  slice(a: number, b: number): { t: number; v: number }[] {
    const out: { t: number; v: number }[] = [];
    let i = Math.max(this.head, this.idx(a));
    if (i < 0) i = this.head;
    for (; i < this.ts.length && this.ts[i] <= b; i++) if (this.ts[i] >= a) out.push({ t: this.ts[i], v: this.v[i] });
    return out;
  }
}
