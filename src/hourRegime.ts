// Hour-of-day regimes (MM_HOUR_REGIME, 2026-11-17 at the user's request; README "Hour-of-day regimes", tools/hourregime/).
// tools/hourregime splits the 24 UTC hours into 1–3 regimes (stage 1: each hour's market state and the paper bot's results;
// stage 2: contiguous arcs on the 24-hour circle, checked against Ward / k-means; each regime's config picked and tested
// walk-forward on the recorder replay) and writes the table to MM_HOUR_REGIME_FILE (config/hour-regimes.json). A window
// runs on the regime of the UTC hour it opens in, decided at the roll, so it keeps one config from open to close.
//   off     nothing happens
//   shadow  the regime and the knobs it would set go in the window's index entry (`hourRegime`, applied false) and a change
//           is logged; the window trades the base config. Allowed live: it changes nothing.
//   on      the window runs on its regime's knobs over the base config (tag +hr, name suffix -hr<regime>, applied true).
//           Live, "on" needs MM_HOUR_REGIME_LIVE=on as well; without it the app runs shadow and says so.
// On, it replaces MM_REGIME (the trailing-spread refit, regime.ts): the engine does not build that one.
// Only the knobs in KNOBS can be set. The cap and order size are clamped to MM_HOUR_REGIME_CAP_MAX / _SIZE_MAX. The live
// loss limit, the wallet check, the rate guard and every other knob are never touched.
import fs from "node:fs";
import path from "node:path";
import { CFG, ROOT } from "./config.js";

type Field = "maxPosition" | "orderSize" | "halfSpread" | "skewAtMax" | "v4FromSec" | "v4QuoteUntilLeftSec" | "raceShare" | "raceLevel" | "joinRel";
/** The knobs a regime may set: env name → CFG field and how the value parses ("off" = null where the knob allows it). */
export const KNOBS: Record<string, { field: Field; off?: boolean; min: number; max: number }> = {
  MM_MAX_POSITION: { field: "maxPosition", min: 5, max: 1000 },
  MM_ORDER_SIZE: { field: "orderSize", min: 5, max: 1000 },
  MM_HALF_SPREAD: { field: "halfSpread", min: 0, max: 0.1 },
  MM_SKEW_AT_MAX: { field: "skewAtMax", min: 0, max: 0.2 },
  MM_V4_FROM_SEC: { field: "v4FromSec", min: 0, max: 300 },                 // 300 = no quotes at all in that regime
  MM_V4_QUOTE_UNTIL_LEFT_SEC: { field: "v4QuoteUntilLeftSec", min: 0, max: 300 },
  MM_RACE_SHARE: { field: "raceShare", off: true, min: 0, max: 1 },
  MM_RACE_LEVEL: { field: "raceLevel", off: true, min: 0, max: 1 },
  MM_JOIN_MAX_REL: { field: "joinRel", off: true, min: 0.1, max: 100 },
};

export interface HourTable {
  version: 1;
  /** When and on what tools/hourregime fitted it (free text for the log and the API). */
  fitted?: string; source?: string;
  regimes: { name: string; hours: number[]; knobs: Record<string, string>; note?: string }[];
}

export interface HourRegimeState {
  mode: "shadow" | "on";
  /** The regime of the window's opening UTC hour, and that hour. */
  name: string; hour: number;
  /** The knobs the regime sets, as applied (after the clamps): env name → value. */
  knobs: Record<string, string>;
  /** true = the window runs on them; false = shadow (recorded only). */
  applied: boolean;
}

function parseKnob(k: string, v: string): number | null {
  const spec = KNOBS[k];
  if (!spec) throw new Error(`knob ${k} is not one a regime may set (${Object.keys(KNOBS).join(", ")})`);
  if (spec.off && String(v).toLowerCase() === "off") return null;
  const x = Number(v);
  if (String(v).trim() === "" || !Number.isFinite(x) || x < spec.min || x > spec.max) throw new Error(`${k}=${v}: needs a number in [${spec.min}, ${spec.max}]${spec.off ? " or off" : ""}`);
  return x;
}

/** The table, checked: every hour 0–23 in exactly one regime, unique names, knobs from KNOBS with valid values. */
export function parseHourTable(raw: unknown): HourTable {
  const t = raw as HourTable;
  if (!t || t.version !== 1 || !Array.isArray(t.regimes) || !t.regimes.length) throw new Error("needs {version: 1, regimes: [...]}");
  if (t.regimes.length > 3) throw new Error(`${t.regimes.length} regimes: at most 3`);
  const seen = new Map<number, string>(), names = new Set<string>();
  for (const r of t.regimes) {
    if (!r || typeof r.name !== "string" || !/^[A-Za-z0-9]{1,8}$/.test(r.name)) throw new Error(`regime name ${JSON.stringify(r?.name)}: 1–8 letters / digits`);
    if (names.has(r.name)) throw new Error(`regime ${r.name} twice`);
    names.add(r.name);
    if (!Array.isArray(r.hours)) throw new Error(`regime ${r.name}: hours must be a list`);
    for (const h of r.hours) {
      if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error(`regime ${r.name}: hour ${h} is not 0–23`);
      if (seen.has(h)) throw new Error(`hour ${h} in both ${seen.get(h)} and ${r.name}`);
      seen.set(h, r.name);
    }
    for (const [k, v] of Object.entries(r.knobs ?? {})) parseKnob(k, String(v));
  }
  const missing = Array.from({ length: 24 }, (_, h) => h).filter((h) => !seen.has(h));
  if (missing.length) throw new Error(`hours ${missing.join(", ")} are in no regime`);
  return t;
}

export function loadHourTable(file: string): HourTable {
  return parseHourTable(JSON.parse(fs.readFileSync(path.resolve(ROOT, file), "utf8")));
}

/** "00–03, 22–23" for the log. */
export function hourBlocks(hours: number[]): string {
  const hs = [...hours].sort((a, b) => a - b), out: string[] = [];
  for (let i = 0; i < hs.length; i++) {
    let j = i;
    while (j + 1 < hs.length && hs[j + 1] === hs[j] + 1) j++;
    out.push(i === j ? `${String(hs[i]).padStart(2, "0")}` : `${String(hs[i]).padStart(2, "0")}–${String(hs[j]).padStart(2, "0")}`);
    i = j;
  }
  return out.join(", ");
}

export class HourRegime {
  readonly mode: "shadow" | "on";
  private readonly byHour: HourTable["regimes"][number][] = [];
  /** The base value of each field this window's regime changed, to put back at the next roll. */
  private saved = new Map<Field, number | null>();
  last: HourRegimeState | null = null;
  recent: (HourRegimeState & { startTs: number })[] = [];

  constructor(readonly table: HourTable, mode: "shadow" | "on", private readonly limits: { capMax: number; sizeMax: number }, private readonly cfg: typeof CFG = CFG) {
    this.mode = mode;
    for (const r of table.regimes) for (const h of r.hours) this.byHour[h] = r;
  }

  /** The base config back in CFG (what the last window's regime changed). true if anything changed. */
  restore(): boolean {
    const c = this.cfg as Record<Field, number | null>;
    let changed = false;
    for (const [f, v] of this.saved) { if (c[f] !== v) { c[f] = v; changed = true; } }
    this.saved.clear();
    return changed;
  }

  /** The regime of a window opening at startTs; "on" sets its knobs in CFG (call restore() first, at every roll). */
  decide(startTs: number): HourRegimeState {
    const hour = new Date(startTs * 1000).getUTCHours(), r = this.byHour[hour];
    const knobs: Record<string, string> = {}, c = this.cfg as Record<Field, number | null>;
    const set: [Field, number | null][] = [];
    for (const [k, raw] of Object.entries(r.knobs ?? {})) {
      let v = parseKnob(k, String(raw));
      if (k === "MM_MAX_POSITION" && v != null) v = Math.min(v, this.limits.capMax);
      if (k === "MM_ORDER_SIZE" && v != null) v = Math.min(v, this.limits.sizeMax);
      knobs[k] = v == null ? "off" : String(v);
      set.push([KNOBS[k].field, v]);
    }
    const applied = this.mode === "on";
    if (applied) for (const [f, v] of set) { if (!this.saved.has(f)) this.saved.set(f, c[f]); c[f] = v; }
    this.last = { mode: this.mode, name: r.name, hour, knobs, applied };
    this.recent.push({ ...this.last, startTs });
    if (this.recent.length > 288) this.recent.splice(0, this.recent.length - 288);
    return this.last;
  }

  /** For the log line at boot. */
  describe(): string {
    return this.table.regimes.map((r) => `${r.name} [${hourBlocks(r.hours)}] ${Object.entries(r.knobs ?? {}).map(([k, v]) => `${k}=${v}`).join(" ") || "base"}`).join(" · ");
  }

  status() {
    return { mode: this.mode, file: this.cfg.hourRegime.file, fitted: this.table.fitted ?? null, source: this.table.source ?? null,
      limits: this.limits, regimes: this.table.regimes, current: this.last, recent: this.recent.slice(-48) };
  }
}

/** The engine's hour regime from CFG: null when off or when the table can't be used. Live "on" without
 *  MM_HOUR_REGIME_LIVE=on runs shadow. A bad table under "on" throws (the app must not run on a config it can't read);
 *  under shadow it is logged and the regime is left off. */
export function hourRegimeFromCfg(log: (m: string) => void, cfg: typeof CFG = CFG): HourRegime | null {
  const h = cfg.hourRegime;
  if (h.mode === "off") return null;
  let mode: "shadow" | "on" = h.mode;
  if (mode === "on" && cfg.mode === "live" && !h.live) {
    log(`[hour-regime] MM_HOUR_REGIME=on is refused live without MM_HOUR_REGIME_LIVE=on: running SHADOW (recorded, not traded)`);
    mode = "shadow";
  }
  let table: HourTable;
  try { table = loadHourTable(h.file); }
  catch (e) {
    const msg = `[hour-regime] ${h.file}: ${(e as Error).message}`;
    if (mode === "on") throw new Error(msg);
    log(`${msg} — shadow off`);
    return null;
  }
  const r = new HourRegime(table, mode, { capMax: h.capMax, sizeMax: h.sizeMax }, cfg);
  log(`[hour-regime] ${mode.toUpperCase()} from ${h.file}${table.fitted ? ` (${table.fitted})` : ""}: ${r.describe()}` +
    (mode === "on" && cfg.regime.on ? " · replaces MM_REGIME (not built)" : ""));
  return r;
}
