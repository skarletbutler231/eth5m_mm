// FOLLOW TRADE — no market making; a taker buy that follows another bot's maker fills (2026-11-11, at the user's request).
// The source bot (eth5m-mm-bot, the paper market maker) sends its own maker fills on WS /signal-fills (signal.ts "FILL
// SIGNAL"): "nocancel" (resting, no cancel sent) and "race" (a race cancel was in flight). On each one of a kind
// FOLLOW_KINDS names, this app buys the SAME token the source bought, as a fill-and-kill taker up to its ask +
// FOLLOW_SLIP, on its own book and paper account, and holds it to settlement (never paired off, never sold).
// Why: the 11-11 taker-follow check on the bots' records (buy the token at the ask at the signal, fee paid): paper race
// fills +13.0¢ a share at settle [+4.3, +21.0] on 90 fills, paper no-cancel −3.8¢ [−6.2, −1.4] on 624, live no-cancel
// +6.8¢ on 236. This is the forward paper test of it, per kind (the window archive's `follows`).
// Rules, each signal: a fill message (never the hello's `recent` replay) of the challenger's current window and market,
// at most FOLLOW_MAX_AGE_MS old, once per source fill message (order id + fill time + seq), from
// FOLLOW_FROM_SEC after the open to FOLLOW_UNTIL_LEFT_SEC before the close, a fresh book with the token's ask between 5¢
// and FOLLOW_MAX_PX, FOLLOW_MAX_WIN_SH shares bought in the window at most. Size: the source fill's shares (FOLLOW_SIZE=0,
// default) or FOLLOW_SIZE, at most FOLLOW_MAX_SH; it spends size × the ask in whole cents, at least the venue's $1.
// Paper only (config.ts throws on live): the take's send → match comes from PAPER_TAKE_MS as every paper take's.
import WebSocket from "ws";
import type { BookView } from "./feeds/pmBook.js";
import type { FillKind, FillMsg } from "./signal.js";
import type { Trader } from "./trading/trader.js";
import type { Token } from "./trading/types.js";
import { takerFee } from "./trading/paperExchange.js";
import type { CFG } from "./config.js";

export type FollowCfg = (typeof CFG)["follow"];

/** The challenger's window as the follow rules see it (null from the engine = its market is not known yet). */
export interface FollowCtx {
  win: number;
  endTs: number;
  up: string;
  down: string;
  /** The Up book (a Down ask is 1 − the Up bid). */
  book: BookView;
  tick: number;
}

/** One source fill signal and what was done with it (the window archive's `follows`). */
export interface FollowRec {
  seq: number;
  kind: FillKind;
  /** The source: its order id, fill time, the shares and token price it bought, its setup name. */
  src: { oid: number; tFill: number; size: number; price: number; name: string };
  /** When the signal went out (source clock = this box's) and when it was heard here. */
  t: number; rx: number;
  dir: "up" | "down";
  /** sent: the take went out; skip: the reason is in `why`. */
  act: "sent" | "skip";
  why: string;
  /** The take: the token's ask at the send, the limit, the shares and USDC asked for, its order id. */
  ask: number | null; limit: number | null; size: number | null; usd: number | null; oid: number | null;
  /** What it filled (filled in as the window runs, and at the close): shares, average price, fee. */
  fill: { qty: number; px: number | null; fee: number };
}

const MIN_USD = 1, MIN_PX = 0.05, EPS = 1e-9;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const c = (x: number) => (x * 100).toFixed(1) + "¢";
const tokName = (t: Token) => (t === "UP" ? "Up" : "Down");

/** The decision on one source fill message, pure (the selftests drive it): a take or the reason for none. */
export function followDecide(m: FillMsg, x: FollowCtx | null, now: number, boughtWin: number, cfg: FollowCfg):
  { take: { token: Token; ask: number; limit: number; size: number; usd: number } } | { skip: string } {
  if (!cfg.kinds[m.kind]) return { skip: `kind ${m.kind} not followed (FOLLOW_KINDS)` };
  if (now - m.t > cfg.maxAgeMs) return { skip: `stale: sent ${now - m.t} ms ago (max ${cfg.maxAgeMs})` };
  if (!x) return { skip: "no market yet" };
  if (m.win !== x.win) return { skip: `window ${m.win}, not ours (${x.win})` };
  const token: Token | null = m.token === x.up ? "UP" : m.token === x.down ? "DOWN" : null;
  if (!token || (token === "UP") !== (m.dir === "up")) return { skip: `token ${m.token.slice(0, 10)}… / ${m.dir} is not this window's` };
  const elapsed = now / 1000 - x.win, left = x.endTs - now / 1000;
  if (elapsed < cfg.fromSec) return { skip: `opening: from ${cfg.fromSec} s` };
  if (left < cfg.untilLeftSec) return { skip: `closing: none in the last ${cfg.untilLeftSec} s` };
  const b = x.book;
  if (!b.ready || b.bestBid == null || b.bestAsk == null || (b.ageMs ?? 0) > 5000) return { skip: "no fresh book" };
  const ask = token === "UP" ? b.bestAsk : r4(1 - b.bestBid);
  if (ask < MIN_PX - EPS || ask > cfg.maxPx + EPS) return { skip: `${tokName(token)} ask ${c(ask)} outside ${c(MIN_PX)}–${c(cfg.maxPx)}` };
  const limit = Math.min(cfg.maxPx, 0.99, r4(Math.round((ask + cfg.slip) / x.tick) * x.tick));
  let size = Math.floor(Math.min(cfg.size > 0 ? cfg.size : m.size, cfg.maxSh) * 100 + EPS) / 100;
  if (cfg.maxWinSh != null) size = Math.min(size, Math.floor((cfg.maxWinSh - boughtWin) * 100 + EPS) / 100);
  if (size <= 0) return { skip: `the window's ${cfg.maxWinSh} sh (FOLLOW_MAX_WIN_SH) are bought` };
  // the venue's market BUY spends USDC: size × the ask in whole cents (a fill at the ask buys ~`size`; the slip only caps
  // the price, so a fill higher buys fewer), at least $1
  const usd = Math.max(MIN_USD, Math.round(size * ask * 100) / 100);
  return { take: { token, ask, limit, size, usd } };
}

/** The follow trade: the source feed's client, the takes, the per-window records. */
export class FollowTrader {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 1000;
  connected = false;
  lastRx = 0;
  /** Source fill messages already handled (order id : fill time : seq), per window. */
  private seen = new Map<number, Set<string>>();
  private recs = new Map<number, FollowRec[]>();
  counts = { heard: 0, sent: 0, skipped: 0 };

  constructor(private readonly trader: Trader, readonly cfg: FollowCfg, private readonly ctx: () => FollowCtx | null,
              private readonly log: (m: string) => void) {}

  desc(): string {
    const k = (Object.keys(this.cfg.kinds) as FillKind[]).filter((x) => this.cfg.kinds[x]).join(" + ");
    return `${k} fills from ${this.cfg.url} → buy the same token ≤ ask + ${c(this.cfg.slip)}, ` +
      `${this.cfg.size > 0 ? `${this.cfg.size} sh` : "the fill's shares"} (≤ ${this.cfg.maxSh}${this.cfg.maxWinSh != null ? `, ${this.cfg.maxWinSh} a window` : ""}), ` +
      `${this.cfg.fromSec}s–${this.cfg.untilLeftSec}s left, ≤ ${c(this.cfg.maxPx)}, signals ≤ ${this.cfg.maxAgeMs} ms old; held to settlement`;
  }

  connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.cfg.url);
    this.ws = ws;
    ws.on("open", () => { this.connected = true; this.backoff = 1000; this.log(`[follow] connected to ${this.cfg.url}`); });
    ws.on("message", (d) => { this.lastRx = Date.now(); try { this.onRaw(String(d), this.lastRx); } catch (e) { this.log(`[follow] error: ${(e as Error).stack}`); } });
    ws.on("error", (e) => this.log(`[follow] socket error: ${e.message}`));
    ws.on("close", () => {
      this.connected = false;
      if (this.ws !== ws || this.stopped) return;
      const w = this.backoff; this.backoff = Math.min(30_000, this.backoff * 2);
      this.log(`[follow] source feed closed; reconnecting in ${w / 1000} s`);
      setTimeout(() => this.connect(), w).unref();
    });
  }

  /** One message of the source feed: only "fill" messages trade. The hello carries the source window's last 20 fills
   *  ("recent"): never traded, or each reconnect would buy them again; heartbeats are only liveness. */
  onRaw(raw: string, now: number): FollowRec | null {
    let m: { type?: string; cfg?: unknown; armed?: boolean } | null = null;
    try { m = JSON.parse(raw); } catch { return null; }
    if (m?.type === "hello") { this.log(`[follow] source hello: kinds ${JSON.stringify(m.cfg)}, armed ${m.armed}`); return null; }
    return m?.type === "fill" ? this.handle(m as unknown as FillMsg, now) : null;
  }

  stop(): void { this.stopped = true; try { this.ws?.close(); } catch { /* */ } }

  /** One source fill message heard now. */
  handle(m: FillMsg, now: number): FollowRec | null {
    if (m.type !== "fill") return null;
    this.counts.heard++;
    let seen = this.seen.get(m.win);
    if (!seen) { seen = new Set(); this.seen.set(m.win, seen); for (const k of this.seen.keys()) if (k < m.win - 3600) this.seen.delete(k); }
    // one taker print can fill an order in pieces at the same fill time (11-11 06:31: #84–#86, one order): seq tells them apart
    const key = `${m.oid}:${m.tFill}:${m.seq}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const x = this.ctx();
    const bought = (this.recs.get(m.win) ?? []).reduce((s, r) => s + (r.act === "sent" ? r.size ?? 0 : 0), 0);
    const d = followDecide(m, x, now, bought, this.cfg);
    const rec: FollowRec = {
      seq: m.seq, kind: m.kind, src: { oid: m.oid, tFill: m.tFill, size: m.size, price: m.price, name: m.name }, t: m.t, rx: now, dir: m.dir,
      act: "skip", why: "", ask: null, limit: null, size: null, usd: null, oid: null, fill: { qty: 0, px: null, fee: 0 },
    };
    const tag = `${m.kind} #${m.seq} (src ${m.dir === "up" ? "Up" : "Down"} ${m.size} @ ${c(m.price)}, order #${m.oid})`;
    if ("skip" in d) rec.why = d.skip;
    else {
      const t = d.take;
      const why = `follow ${m.kind} · src #${m.oid} ${m.size} @ ${c(m.price)} · ${t.size} ${tokName(t.token)} ≤ ${c(t.limit)}, ask ${c(t.ask)}, fee ${c(takerFee(t.limit))}/sh`;
      const o = this.trader.take(x!.win, t.token, t.limit, t.size, why, now, t.usd);
      if (!o) rec.why = "no orders may go out now";
      else {
        Object.assign(rec, { act: "sent", why, ask: t.ask, limit: t.limit, size: t.size, usd: t.usd, oid: o.id });
      }
    }
    if (rec.act === "sent") this.counts.sent++; else this.counts.skipped++;
    if (m.win === x?.win || rec.act === "sent") {
      let list = this.recs.get(m.win);
      if (!list) { list = []; this.recs.set(m.win, list); for (const k of this.recs.keys()) if (k < m.win - 3600) this.recs.delete(k); }
      list.push(rec);
    }
    this.log(`[follow] ${tag} ${now - m.t} ms → ${rec.act === "sent" ? `buy ${rec.size} ${m.dir === "up" ? "Up" : "Down"} ≤ ${c(rec.limit!)} (ask ${c(rec.ask!)}, $${rec.usd!.toFixed(2)})` : `skip: ${rec.why}`}`);
    return rec;
  }

  /** The window's records with their fills as booked now. */
  records(win: number): FollowRec[] {
    const list = this.recs.get(win) ?? [];
    for (const r of list) if (r.oid != null) r.fill = this.trader.fillsOf(win, r.oid);
    return list;
  }

  /** For /api/status: the source feed and the counts since the start. */
  status() {
    return { connected: this.connected, lastRxAgoMs: this.lastRx ? Date.now() - this.lastRx : null, ...this.counts, url: this.cfg.url };
  }
}
