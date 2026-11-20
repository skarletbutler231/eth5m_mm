// Window archive: one gzip'd JSON per window (every 100 ms frame row) plus an append-only index.
//   data/windows/YYYY-MM-DD/<startTs>.json.gz
//   data/index.jsonl     one line per write; later lines for the same startTs merge over earlier ones
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import type { HourRegimeState } from "./hourRegime.js";
import type { Score } from "./model/scorecard.js";
import type { PaperSummary } from "./trading/account.js";

const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);

export interface IndexEntry {
  startTs: number;
  endTs?: number;
  slug?: string | null;
  marketId?: string | null;
  twapSec?: number;
  Kcl?: number | null;           // Chainlink TWAP strike (price to beat)
  KclSrc?: string | null;
  Kv?: number | null;            // Binance venue-internal strike
  KvSrc?: string | null;
  up?: boolean | null;
  src?: string | null;           // label source: chainlink (provisional) | gamma (final)
  closeTwap?: number | null;
  priceToBeat?: number | null;   // Gamma eventMetadata.priceToBeat
  kappa?: number;
  kappaMed?: number | null;
  sigmaBase?: number | null;
  model?: string;
  epsBps?: number;
  lagMs?: number;
  nc?: { w: number; lagB: number; lagC: number } | null;   // nowcast blend at the close: Coinbase weight, both lags
  rows?: number;
  joinedLate?: boolean;
  cut?: boolean;                 // written at shutdown before the window ended
  score?: Score;
  paper?: PaperSummary;          // paper trading result of the window (sums; pnl final once settled)
  policy?: "v1" | "v2" | "v3" | "v4" | "v5" | "cert";  // quoting policy the window ran (MM_POLICY A/B; "v5" before 2026-10-22 = cert)
  tag?: string;                  // quoting setup: the policy, "+queue" with queue retention (2026-10-10)
  name?: string;                 // the setup's short name (MM_TAG, 2026-11-10): the dashboard's column and window-list label
  regime?: { name: "calm" | "busy" | "unknown"; spr: number | null; vol: number | null; n: number; cap: number; size: number };   // MM_REGIME (2026-11-14)
  session?: { label: string | null; size: number; cap: number; stopped: boolean };   // MM_SESSIONS (control.ts, 2026-11-17)
  hourRegime?: HourRegimeState;   // MM_HOUR_REGIME (2026-11-17): the hour's regime, its knobs, applied or shadow
}

export const utcDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

export class Store {
  private idx = new Map<number, IndexEntry>();
  private indexFile: string;

  constructor(private readonly dir: string) {
    fs.mkdirSync(path.join(dir, "windows"), { recursive: true });
    this.indexFile = path.join(dir, "index.jsonl");
    if (fs.existsSync(this.indexFile)) {
      for (const line of fs.readFileSync(this.indexFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line) as IndexEntry; this.idx.set(e.startTs, { ...(this.idx.get(e.startTs) ?? {}), ...e }); } catch { /* torn line */ }
      }
    }
  }

  get(startTs: number): IndexEntry | undefined { return this.idx.get(startTs); }
  entries(): IndexEntry[] { return [...this.idx.values()]; }

  upsert(e: IndexEntry): void {
    const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as IndexEntry;
    this.idx.set(e.startTs, { ...(this.idx.get(e.startTs) ?? {}), ...clean });
    fs.appendFileSync(this.indexFile, JSON.stringify(clean) + "\n");
  }

  dates(): string[] {
    return [...new Set(this.entries().map((e) => utcDate(e.startTs)))].sort().reverse();
  }

  byDate(date: string): IndexEntry[] {
    return this.entries().filter((e) => utcDate(e.startTs) === date).sort((a, b) => b.startTs - a.startTs);
  }

  private file(startTs: number): string {
    return path.join(this.dir, "windows", utcDate(startTs), `${startTs}.json.gz`);
  }

  async writeWindow(startTs: number, payload: unknown): Promise<void> {
    const f = this.file(startTs);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    await fs.promises.writeFile(f, await gzip(Buffer.from(JSON.stringify(payload))));
  }

  /** Synchronous write, for the shutdown path only. */
  writeWindowSync(startTs: number, payload: unknown): void {
    const f = this.file(startTs);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
  }

  readWindowSync(startTs: number): any | null {
    const f = this.file(startTs);
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString()); } catch { return null; }
  }

  async readWindow(startTs: number): Promise<any | null> {
    const f = this.file(startTs);
    if (!fs.existsSync(f)) return null;
    return JSON.parse((await gunzip(await fs.promises.readFile(f))).toString());
  }
}
