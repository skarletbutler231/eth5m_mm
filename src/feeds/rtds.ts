// Chainlink <asset>/USD (asset.ts: eth/usd) from Polymarket: spot (~1 Hz) plus the 60 s TWAP the 5-minute market settles on (30 s on RTDS only:
// PolyBolt has none, and the markets settle on 60 s since 2026-08-14). Every value carries Chainlink's OBSERVATION
// timestamp, which is what strike and settlement are keyed on. Two transports, one at a time:
//  - PolyBolt (wss://ws-live-v2.polymarket.com/ws, launched 2026-09-15; docs.polymarket.com/migrate/rtds-to-polybolt):
//    the default when POLYBOLT_API_KEY is set. Needs a CLOB L2 key (any account's: tools/polybolt/feedkey.mjs makes a
//    feed-only one off an empty EOA) and from 2026-11-30 00:00 UTC also a Chainlink API key (CHAINLINK_API_KEY). Checked
//    2026-11-20 against RTDS over 178 s: the same value every second for spot and TWAP, ~230 ms (spot) / ~200 ms (TWAP)
//    earlier (tools/polybolt/compare.mjs). `full_accuracy_value` is a plain decimal there, not E18. Server pings itself.
//    A fatal answer (bad key, Chainlink key or provider wanted, a provider other than chainlink) → RTDS for 10 minutes.
//  - RTDS (wss://ws-live-data.polymarket.com): key-free, legacy for prices since 2026-09-15, removal announced.
//
// Rules carried over from pmqb (each one cost a wrong label there):
//  - a boundary report is the one stamped exactly T, else the FIRST one after T (<= 5 s). Never walk
//    backwards: that produced 13 wrong provisional labels in pmqb (memory settle-ring-walkback-bug).
//  - null until a report stamped >= T has arrived; callers retry.
//  - RTDS needs a literal "PING" text frame every 5 s, compact JSON filters, and a re-subscribe until
//    a topic actually delivers ("topic not found" leaves a healthy-looking socket silent).
//  - The socket can stay open and keep answering (pings, subscribe acks) while the prices stop: 2026-11-11/12/13 it did so
//    for up to 105 minutes at a time (22 + 16 + 15 windows on an estimated price to beat), until RTDS's own 2-hourly close.
//    So the watchdog keys on the last PRICE (STALE_MS), not on any message.
//  - Every subscribe is answered with the topic's last ~60 s (1 s apart, the same values as the live updates: checked
//    2026-11-13 on 24 shared seconds): the TWAP ring takes them, so a reconnect does not lose the reports of the gap.
//    PolyBolt's snapshot holds ~2 minutes (119 s seen), of the spot too, in full accuracy: it fills the spot buffer forward.
import WebSocket from "ws";
import { PriceBuffer } from "../model/priceBuffer.js";
import { ASSET } from "../asset.js";

const URL = "wss://ws-live-data.polymarket.com";
const SYMBOL = ASSET.chainlink;
const TOPIC_SPOT = "crypto_prices_chainlink";
const TOPIC_TWAP: Record<30 | 60, string> = { 30: "crypto_prices_twap_thirty", 60: "crypto_prices_twap_sixty" };
const PB_URL = "wss://ws-live-v2.polymarket.com/ws";
/** PolyBolt names it without the slash (btcusd, ethusd; checked live for both 2026-11-20). */
const PB_SYMBOL = ASSET.chainlink.replace("/", "");
const PB_SPOT = "price.crypto";
const PB_TWAP = "price.crypto.twap";
/** PolyBolt answers that no reconnect cures: fall back to RTDS for FALLBACK_MS, then try PolyBolt again. */
const PB_FATAL = new Set(["auth_invalid", "chainlink_key_required", "provider_required", "auth_attempts"]);
const FALLBACK_MS = 10 * 60_000;
const RING_SEC = 4 * 3600;
const TOLERANCE_SEC = 5;
/** No Chainlink price (spot or TWAP update, both ~1 Hz) this long on an open socket, counted from the later of the last
 *  price and the connect: reconnect. */
export const STALE_MS = 10_000;

export interface Tick { v: number; ts: number; rx: number }

/** PolyBolt credentials: a CLOB L2 key (apiKey/secret/passphrase) and, from 2026-11-30, the Chainlink API key. */
export interface PolyBoltCreds { apiKey: string; secret: string; passphrase: string; chainlinkKey?: string }

export class RtdsFeed {
  readonly spot = new PriceBuffer(20 * 60_000);
  spotLatest: Tick | null = null;
  twapLatest: Record<30 | 60, Tick | null> = { 30: null, 60: null };
  private ring: Record<30 | 60, Map<number, number>> = { 30: new Map(), 60: new Map() };
  private newest: Record<30 | 60, number> = { 30: -Infinity, 60: -Infinity };
  private got = new Set<string>();
  private ws: WebSocket | null = null;
  private twapCbs: ((w: 30 | 60, sec: number, v: number) => void)[] = [];
  /** The transport of the current (or next) socket. */
  kind: "polybolt" | "rtds";
  /** PolyBolt: the auth was accepted on this socket (subscribes wait for it). */
  private authed = false;
  /** PolyBolt refused for good (bad key, Chainlink key wanted …): RTDS until then. */
  private fallbackUntil = 0;
  connected = false;
  reconnects = 0;
  /** Any message (pings answered, acks included). */
  lastRx = 0;
  /** The last Chainlink price update (spot or TWAP) and the last connect: the staleness watchdog's clock. */
  lastPrice = 0;
  openAt = 0;
  lastError = "";

  constructor(private readonly log: (m: string) => void, private readonly pb: PolyBoltCreds | null = null) {
    this.kind = pb ? "polybolt" : "rtds";
  }

  onTwap(cb: (w: 30 | 60, sec: number, v: number) => void): void { this.twapCbs.push(cb); }

  /**
   * The settlement report for epoch second T: exact, else first after T within 5 s, else null.
   * The forward walk is only valid when T is a GENUINE Chainlink gap second, i.e. we were receiving
   * across it (a report stamped in the 3 s before T). Otherwise the missing report is OUR gap (cold
   * start, reconnect) and the next report is a different price: return null so the caller estimates
   * or waits for Gamma. (Caught 2026-10-07: a start 3 s after the open struck on the +5 s report.)
   */
  reportAt(tsSec: number, w: 30 | 60 = 60): { value: number; sec: number } | null {
    const r = this.ring[w];
    const exact = r.get(tsSec);
    if (exact != null) return { value: exact, sec: tsSec };
    if (this.newest[w] < tsSec) return null;
    if (!(r.has(tsSec - 1) || r.has(tsSec - 2) || r.has(tsSec - 3))) return null;
    for (let t = tsSec + 1; t <= tsSec + TOLERANCE_SEC; t++) {
      const v = r.get(t);
      if (v != null) return { value: v, sec: t };
    }
    return null;
  }

  /** True once reports stamped past T + tolerance exist and none answered — an outage at T. */
  missedAt(tsSec: number, w: 30 | 60 = 60): boolean {
    return this.newest[w] > tsSec + TOLERANCE_SEC && this.reportAt(tsSec, w) == null;
  }

  twapSeries(w: 30 | 60, fromSec: number): [number, number][] {
    const out: [number, number][] = [];
    for (const [s, v] of this.ring[w]) if (s >= fromSec) out.push([s, v]);
    return out.sort((a, b) => a[0] - b[0]);
  }

  start(): void {
    this.connect();
    // RTDS wants a text PING every 5 s; PolyBolt pings by itself (ws answers), its op ping only keeps lastRx moving
    setInterval(() => {
      try { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(this.kind === "polybolt" ? '{"op":"ping"}' : "PING"); } catch { /* */ }
    }, 5000).unref();
    setInterval(() => this.subscribe(), 30_000).unref();
    setInterval(() => {
      const why = this.staleWhy(Date.now());
      if (!why) return;
      this.lastError = why;
      this.log(`[rtds] ${why}, reconnecting`);
      try { this.ws?.terminate(); } catch { /* */ }
    }, 2000).unref();
  }

  /** Why the open socket counts as dead (null = fine): nothing at all for 30 s, or no Chainlink price for STALE_MS while
   *  other messages still come (the stall of 2026-11-11..13). */
  staleWhy(now: number): string | null {
    if (!this.connected) return null;
    if (now - this.lastRx > 30_000) return "no message for 30 s";
    const since = Math.max(this.lastPrice, this.openAt);
    if (now - since > STALE_MS) return `no Chainlink price for ${Math.round((now - since) / 1000)} s while the socket still answers`;
    return null;
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.kind === "polybolt") {
      if (!this.authed) return;
      const subs = [
        { key: PB_SPOT, channel: PB_SPOT, filter: { symbol: PB_SYMBOL, provider: "chainlink" } },
        { key: PB_TWAP, channel: PB_TWAP, filter: { symbol: PB_SYMBOL, window_seconds: 60, provider: "chainlink" } },
      ].filter((s) => !this.got.has(s.key));
      if (!subs.length) return;
      this.ws.send(JSON.stringify({ op: "subscribe", rid: "s", subscriptions: subs.map(({ channel, filter }) => ({ channel, filter })) }));
      return;
    }
    const topics = [TOPIC_SPOT, TOPIC_TWAP[30], TOPIC_TWAP[60]].filter((t) => !this.got.has(t));
    if (!topics.length) return;
    this.ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: topics.map((topic) => ({ topic, type: "update", filters: JSON.stringify({ symbol: SYMBOL }) })),
    }));
  }

  private connect(): void {
    this.kind = this.pb && Date.now() >= this.fallbackUntil ? "polybolt" : "rtds";
    const pb = this.kind === "polybolt";
    const ws = new WebSocket(pb ? PB_URL : URL);
    this.ws = ws;
    this.got.clear();
    this.authed = false;
    ws.on("open", () => {
      this.connected = true; this.lastRx = this.openAt = Date.now();
      if (pb) {
        const p = this.pb!;
        ws.send(JSON.stringify({ op: "auth", rid: "a", auth: { apiKey: p.apiKey, secret: p.secret, passphrase: p.passphrase },
          ...(p.chainlinkKey ? { chainlink_api_key: p.chainlinkKey } : {}) }));
      } else this.subscribe();
      this.log(`[rtds] connected (${this.kind})`);
    });
    ws.on("message", (buf) => this.apply(buf.toString()));
    const down = (why: string) => {
      if (this.ws !== ws) return;
      this.ws = null; this.connected = false; this.reconnects++; this.lastError = why;
      this.log(`[rtds] ${this.kind} down (${why}), reconnecting in 2 s`);
      setTimeout(() => this.connect(), 2000).unref();
    };
    ws.on("close", (c) => down(`close ${c}`));
    ws.on("error", (e) => { try { ws.terminate(); } catch { /* */ } down(e.message); });
  }

  /** PolyBolt refused for good: RTDS for FALLBACK_MS (the next connect picks it). */
  private fallBack(why: string): void {
    this.fallbackUntil = Date.now() + FALLBACK_MS;
    this.lastError = `polybolt: ${why}`;
    this.log(`[rtds] ⚠ PolyBolt ${why}: RTDS for ${FALLBACK_MS / 60_000} min`);
    try { this.ws?.terminate(); } catch { /* */ }
  }

  /** One message off the socket. Public so the self-test can drive it without a socket. */
  apply(raw: string, now = Date.now()): void {
    this.lastRx = now;
    if (this.kind === "polybolt") { this.applyPb(raw, now); return; }
    let msg: { topic?: string; type?: string; payload?: Record<string, unknown>; error?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.error) { this.lastError = JSON.stringify(msg.error); return; }
    const p = msg.payload;
    if (!p || !msg.topic) return;
    if (typeof p.symbol === "string" && p.symbol.toLowerCase() !== SYMBOL) return;
    if (msg.type === "subscribe") {
      const w = (msg.topic === TOPIC_TWAP[60] ? 60 : msg.topic === TOPIC_TWAP[30] ? 30 : 0) as 30 | 60 | 0;
      if (w) this.backfill(w, msg.topic, p.data, now, true);
      return;
    }
    if (msg.type !== "update") return;
    const v = priceOf(p, true); const ts = Number(p.timestamp);
    if (v == null || !Number.isFinite(ts)) return;
    if (msg.topic === TOPIC_SPOT) { this.noteSpot(msg.topic, v, ts, now); return; }
    const w = (msg.topic === TOPIC_TWAP[60] ? 60 : msg.topic === TOPIC_TWAP[30] ? 30 : 0) as 30 | 60 | 0;
    if (w) this.noteTwap(msg.topic, w, v, ts, now);
  }

  private applyPb(raw: string, now: number): void {
    let msg: { op?: string; code?: string; channel?: string; provider?: string; snapshot?: boolean; dropped?: number;
      payload?: Record<string, unknown> };
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.op === "authed") { this.authed = true; this.subscribe(); return; }
    if (msg.op === "error") {
      const code = String(msg.code ?? "?");
      if (PB_FATAL.has(code)) this.fallBack(code); else { this.lastError = `polybolt: ${code}${msg.channel ? ` (${msg.channel})` : ""}`; this.log(`[rtds] PolyBolt error ${code}`); }
      return;
    }
    // a pin the server cannot serve falls back to its default provider: a different price, never strike or settle on it
    if (msg.op === "subscribed") { if (msg.provider && msg.provider !== "chainlink") this.fallBack(`served ${msg.channel} from ${msg.provider}`); return; }
    const p = msg.payload;
    if (!p || (msg.channel !== PB_SPOT && msg.channel !== PB_TWAP)) return;
    if (String(p.symbol ?? PB_SYMBOL).toLowerCase() !== PB_SYMBOL) return;
    if (p.source != null && p.source !== "chainlink") { this.fallBack(`sent ${msg.channel} from ${String(p.source)}`); return; }
    if (msg.dropped) this.log(`[rtds] PolyBolt dropped ${msg.dropped} frame(s) on ${msg.channel} (slow consumer)`);
    if (msg.channel === PB_TWAP && p.window_seconds != null && Number(p.window_seconds) !== 60) return;
    if (msg.snapshot) {
      if (msg.channel === PB_TWAP) this.backfill(60, PB_TWAP, p.data, now, false);
      else this.backfillSpot(p.data);
      return;
    }
    const v = priceOf(p, false); const ts = Number(p.timestamp);
    if (v == null || !Number.isFinite(ts)) return;
    if (msg.channel === PB_SPOT) this.noteSpot(PB_SPOT, v, ts, now);
    else this.noteTwap(PB_TWAP, 60, v, ts, now);
  }

  private noteSpot(topic: string, v: number, ts: number, now: number): void {
    this.lastPrice = now;
    if (!this.got.has(topic)) { this.got.add(topic); this.log(`[rtds] ${topic} live ($${v.toFixed(2)})`); }
    this.spotLatest = { v, ts, rx: now };
    this.spot.push(ts, v);
  }

  private noteTwap(topic: string, w: 30 | 60, v: number, ts: number, now: number): void {
    this.lastPrice = now;
    if (!this.got.has(topic)) { this.got.add(topic); this.log(`[rtds] ${topic} live ($${v.toFixed(2)})`); }
    this.twapLatest[w] = { v, ts, rx: now };
    const sec = Math.floor(ts / 1000);
    this.ring[w].set(sec, v);
    if (sec > this.newest[w]) this.newest[w] = sec;
    this.trim(w, sec);
    for (const cb of this.twapCbs) { try { cb(w, sec, v); } catch { /* */ } }
  }

  /** A TWAP topic's subscribe history into its ring (the seconds it lacks; live values stand), so the boundary reports of
   *  a stall or a reconnect gap are found after all. Not to the TWAP callbacks (calibration): the spot buffer has the same
   *  gap. RTDS's spot history comes under "crypto_prices", without full accuracy: not used. Returns how many it added. */
  private backfill(w: 30 | 60, topic: string, data: unknown, now: number, e18: boolean): number {
    if (!Array.isArray(data)) return 0;
    let n = 0, top = -Infinity;
    for (const d of data as Record<string, unknown>[]) {
      const v = d && typeof d === "object" ? priceOf(d, e18) : null, ts = Number(d?.timestamp);
      if (v == null || !Number.isFinite(ts)) continue;
      const sec = Math.floor(ts / 1000);
      if (!this.ring[w].has(sec)) { this.ring[w].set(sec, v); n++; }
      if (sec > this.newest[w]) { this.newest[w] = sec; this.twapLatest[w] = { v, ts, rx: now }; }
      if (sec > top) top = sec;
    }
    if (n) { this.trim(w, top); this.log(`[rtds] ${topic}: ${n} report(s) filled in from the subscribe history`); }
    return n;
  }

  /** PolyBolt's spot snapshot (full accuracy): only the prints after the buffer's last, so the history never rewrites
   *  what was seen live (a cold start gets the last ~2 minutes; a reconnect gap only what it missed). Not a live price
   *  for the watchdog or spotLatest. */
  private backfillSpot(data: unknown): number {
    if (!Array.isArray(data)) return 0;
    const pts = (data as Record<string, unknown>[])
      .map((d) => [Number(d?.timestamp), d && typeof d === "object" ? priceOf(d, false) : null] as const)
      .filter((x): x is readonly [number, number] => Number.isFinite(x[0]) && x[1] != null)
      .sort((a, b) => a[0] - b[0]);
    let n = 0;
    for (const [ts, v] of pts) { const last = this.spot.lastTs(); if (last == null || ts > last) { this.spot.push(ts, v); n++; } }
    if (n) this.log(`[rtds] ${PB_SPOT}: ${n} spot print(s) filled in from the subscribe history`);
    return n;
  }

  private trim(w: 30 | 60, sec: number): void {
    if (this.ring[w].size <= RING_SEC + 300) return;
    const cut = sec - RING_SEC;
    for (const k of this.ring[w].keys()) if (k < cut) this.ring[w].delete(k);
  }
}

/** `full_accuracy_value` when present (the docs call `value` an approximation): RTDS sends it as an E18 fixed-point
 *  integer, PolyBolt as a plain decimal ("62000" there is $62,000, not 6.2e-14). */
function priceOf(p: Record<string, unknown>, e18: boolean): number | null {
  const raw = p.full_accuracy_value;
  if (typeof raw === "string" && (e18 ? /^\d+$/ : /^\d+(\.\d+)?$/).test(raw)) {
    const n = e18 ? Number(BigInt(raw)) / 1e18 : Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const v = Number(p.value);
  return Number.isFinite(v) && v > 0 ? v : null;
}
