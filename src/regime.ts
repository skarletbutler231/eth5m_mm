// Market regime refit (MM_REGIME, 2026-11-14 at the user's request; README "Market regime refit").
// At each window's open the bot looks at the last MM_REGIME_WINDOWS closed windows (default 6 = 30 min) and calls the
// market BUSY when their mean Up-book spread is at least MM_REGIME_BUSY_SPR, or their BTC 1 s volatility at least
// MM_REGIME_BUSY_VOL (bp), else CALM; with fewer than MM_REGIME_MIN_WINDOWS of them it is UNKNOWN. The window then runs on
// that regime's cap and order size (MM_REGIME_<CALM|BUSY>_CAP / _SIZE; unset = MM_MAX_POSITION / MM_ORDER_SIZE, as
// UNKNOWN does). Why market state and not recent P&L: a window's P&L swings $4–9 against a ~$1 mean, so a P&L refit
// chases noise, while the state is measured in minutes and persists (vol r 0.80 window to window). Paper week to
// 11-14: the trailing 30-min spread's top quartile (≥ 1.16¢) made +$1.17 a window, the bottom half +$0.11; 11-14
// 02:00–05:00 UTC (spread 1.3–1.5¢, 16–20 fills a window) +$4/window, the calm hours after it ~3 fills a window,
// one-sided 20-share fills held to the close. Off by default.
import { CFG } from "./config.js";

export type RegimeName = "calm" | "busy" | "unknown";

/** One closed window's market state: mean Up-book spread over its first 180 s (quoting time), BTC 1 s log-return
 *  volatility in bp. null = not measured (no book, no Binance). */
export interface WinStats { startTs: number; spr: number | null; vol: number | null }

export interface RegimeCfg {
  windows: number; minWindows: number; busySpr: number | null; busyVol: number | null;
  calm: { cap: number | null; size: number | null }; busy: { cap: number | null; size: number | null };
}

export interface RegimeState {
  name: RegimeName;
  /** The trailing means it was decided on, and how many windows they cover. */
  spr: number | null; vol: number | null; n: number;
  /** The cap and order size the window runs on. */
  cap: number; size: number;
}

export function regimeCfg(cfg: typeof CFG = CFG): RegimeCfg | null {
  return cfg.regime.on ? cfg.regime : null;
}

/** A window's market state from its recorded 100 ms rows (engine.ts COLS). */
export function winStats(startTs: number, rows: readonly (readonly (number | null)[])[], cols: readonly string[]): WinStats {
  const ix = (n: string) => cols.indexOf(n);
  const iEl = ix("el"), iBb = ix("bb"), iBa = ix("ba"), iBin = ix("bin");
  let sSum = 0, sN = 0, r2 = 0, rN = 0, last: number | null = null, next = 0;
  for (const r of rows) {
    const el = r[iEl];
    if (el == null) continue;
    const bb = r[iBb], ba = r[iBa];
    if (el <= 180 && bb != null && ba != null && ba > bb) { sSum += ba - bb; sN++; }
    const px = r[iBin];
    if (px != null && px > 0 && el >= next) {
      if (last != null) { const x = Math.log(px / last) * 1e4; r2 += x * x; rN++; }
      last = px; next = Math.floor(el) + 1;
    }
  }
  return { startTs, spr: sN ? sSum / sN : null, vol: rN >= 30 ? Math.sqrt(r2 / rN) : null };
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export class Regime {
  private hist: WinStats[] = [];
  /** The cap and size the bot booted with: UNKNOWN's, and every regime knob left unset. */
  private base: { cap: number; size: number };
  last: RegimeState | null = null;

  constructor(private readonly cfg: RegimeCfg, base: { cap: number; size: number }) { this.base = { ...base }; }

  /** The dashboard's size switch (control.ts) changed the bot's own cap and size. */
  setBase(base: { cap: number; size: number }): void { this.base = { ...base }; }

  /** A closed window's state (a repeat of a window replaces it). */
  push(s: WinStats): void {
    this.hist = this.hist.filter((h) => h.startTs !== s.startTs);
    this.hist.push(s);
    this.hist.sort((a, b) => a.startTs - b.startTs);
    if (this.hist.length > 4 * this.cfg.windows) this.hist.splice(0, this.hist.length - 4 * this.cfg.windows);
  }

  /** The regime a window opening at startTs runs on: the windows that closed in the MM_REGIME_WINDOWS × 5 min before it. */
  decide(startTs: number): RegimeState {
    const from = startTs - this.cfg.windows * 300;
    const h = this.hist.filter((x) => x.startTs >= from && x.startTs < startTs);
    const spr = mean(h.flatMap((x) => (x.spr != null ? [x.spr] : [])));
    const vol = mean(h.flatMap((x) => (x.vol != null ? [x.vol] : [])));
    let name: RegimeName = "unknown";
    if (h.length >= this.cfg.minWindows) {
      const busy = (this.cfg.busySpr != null && spr != null && spr >= this.cfg.busySpr - 1e-12) ||
        (this.cfg.busyVol != null && vol != null && vol >= this.cfg.busyVol);
      name = busy ? "busy" : "calm";
    }
    const k = name === "unknown" ? { cap: null, size: null } : this.cfg[name];
    this.last = { name, spr, vol, n: h.length, cap: k.cap ?? this.base.cap, size: k.size ?? this.base.size };
    return this.last;
  }
}
