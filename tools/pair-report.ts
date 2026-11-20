// How the pair trade (src/pairTrader.ts) is doing: the pairs archived in each window file and the account's window PnL.
//   npm run pair:report                 data-pair/ (the pm2 app eth5m-pair)
//   npm run pair:report -- data-other   another data dir
//   npm run pair:report -- data-pair 2026-10-15T19:50   only the pairs from then on (UTC), e.g. since a settings change
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { PairRec } from "../src/pairTrader.js";

const dir = path.resolve(process.argv[2] ?? "data-pair");
const since = process.argv[3] ? Date.parse(process.argv[3].endsWith("Z") ? process.argv[3] : process.argv[3] + "Z") : -Infinity;
if (Number.isNaN(since)) { console.log(`can't read the time ${process.argv[3]} (e.g. 2026-10-15T19:50)`); process.exit(1); }
const wdir = path.join(dir, "windows");
if (!fs.existsSync(wdir)) { console.log(`no windows in ${dir} yet`); process.exit(0); }

const recs: PairRec[] = [];
let wins = 0;
for (const day of fs.readdirSync(wdir).sort()) {
  for (const f of fs.readdirSync(path.join(wdir, day)).sort()) {
    if ((parseInt(f, 10) + 300) * 1000 < since) continue;   // the window ended before `since`
    try {
      const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(wdir, day, f))).toString());
      if (!String(d.meta?.tag ?? "").startsWith("pair")) continue;
      wins++;
      recs.push(...((d.pairs ?? []) as PairRec[]).filter((r) => r.t >= since));
    } catch { /* a window being written */ }
  }
}
const pnlByWin = new Map<number, number>();
const idx = path.join(dir, "index.jsonl");
if (fs.existsSync(idx)) {
  for (const line of fs.readFileSync(idx, "utf8").split("\n")) {
    try { const e = JSON.parse(line); if (String(e.tag ?? "").startsWith("pair") && e.paper?.settled && e.startTs * 1000 >= since) pnlByWin.set(e.startTs, e.paper.pnl); } catch { /* */ }
  }
}

const n = (k: PairRec["end"]) => recs.filter((r) => r.end === k).length;
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");
console.log(`${dir}: ${wins} pair windows, ${recs.length} signals traded (${(recs.length / Math.max(1, wins)).toFixed(1)} a window)`);
console.log(`  leg 1 filled ${pct(recs.length - n("missed"), recs.length)} · paired ${n("paired")} · missed ${n("missed")} · held ${n("held")}`);
const split = (label: string, R: PairRec[]) => {
  const Pk = R.filter((r) => r.pnl != null && r.leg2.qty > 0), c = Pk.map((r) => (r.pnl! / Math.min(r.leg1.qty, r.leg2.qty)) * 100);
  console.log(`  ${label}: ${R.length} sent, ${pct(R.length - R.filter((r) => r.end === "missed").length, R.length)} filled, ${Pk.length} paired` +
    (c.length ? ` at ${(c.reduce((a, b) => a + b, 0) / c.length).toFixed(2)}¢ a pair, ${pct(c.filter((x) => x > 0).length, c.length)} won, $${Pk.reduce((a, r) => a + r.pnl!, 0).toFixed(2)}` : ""));
};
// leg 1 went out as a post-only bid (maker) or a fill-and-kill take (taker; archives before the maker mode have no kind)
for (const k of ["maker", "taker"] as const) {
  const R = recs.filter((r) => (r.kind ?? "taker") === k);
  if (R.length && !(R.length === recs.length && k === "taker")) split(`${k} leg 1`, R);
}
// the detector that opened the pair: its own (archives before /signal-fast have no signal) or /signal-fast's
if (recs.some((r) => r.signal === "fast")) {
  for (const k of ["own", "fast"] as const) {
    const R = recs.filter((r) => (r.signal ?? "own") === k);
    if (!R.length) continue;
    const kinds = [...new Set(R.map((r) => r.kind ?? "taker"))].join("/");
    split(`${k === "fast" ? "/signal-fast" : "own detector"} (${[...new Set(R.map((r) => r.lookbackMs ?? "?"))].join("/")} ms, ${kinds} leg 1)`, R);
  }
}
const P = recs.filter((r) => r.pnl != null && r.leg2.qty > 0);
if (P.length) {
  const c = P.map((r) => (r.pnl! / r.leg2.qty) * 100);
  const m = c.reduce((a, b) => a + b, 0) / c.length;
  const se = Math.sqrt(c.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, c.length - 1) / c.length);
  console.log(`  paired: ${m >= 0 ? "+" : ""}${m.toFixed(2)}¢ a pair after fees (±${se.toFixed(2)}), ${pct(c.filter((x) => x > 0).length, c.length)} won, ` +
    `$${P.reduce((a, r) => a + r.pnl!, 0).toFixed(2)} in all (backtest: +4.6¢ ±0.5, 71% won)`);
  const slip = P.map((r) => (r.leg1.px! - r.ask0) * 100), lag = P.map((r) => r.leg1.at! - r.t).sort((a, b) => a - b);
  console.log(`  leg 1: ${(slip.reduce((a, b) => a + b, 0) / slip.length).toFixed(2)}¢ over the signal's ask on average (a maker bid: under it), filled a median ${lag[lag.length >> 1]} ms after it · ` +
    `leg 2: at most ${Math.max(...P.map((r) => r.leg2.tries))} tries`);
}
const w = [...pnlByWin.values()];
if (w.length) console.log(`  account: ${w.length} settled windows, $${w.reduce((a, b) => a + b, 0).toFixed(2)} (${(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2)} a window), held leftovers settled at the label`);
