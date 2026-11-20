// Polymarket CLOB market channel -> full event-level book per token (Up and Down), sub-second.
// Adapted from pmqb packages/execution/src/traders/pmBookStream.ts.
//
//   connect  wss://ws-subscriptions-clob.polymarket.com/ws/market
//   first    {"assets_ids":[...], "type":"market"}                    -> one `book` snapshot per token
//   later    {"assets_ids":[...], "operation":"subscribe"|"unsubscribe"}
//   keepalive "PING" every 10 s
//   `book`          replaces both sides of one token
//   `price_change`  {price_changes:[{asset_id, price, size, side}]}, size = the level's NEW total
//                   (0 = gone), side BUY = bid, SELL = ask; usually both tokens' mirror changes at once
//   `tick_size_change` {asset_id, old_tick_size, new_tick_size}: the price grid narrows (1¢ → 0.1¢); orders off the
//                   grid are rejected, so the quoter must follow this event, not a price rule
//   `last_trade_price` {asset_id, price, size, side, timestamp}; side = the TAKER's side. Each match
//                   prints on ONE token only (probe 2026-10-07: 0 of 121 Up prints had a Down mirror),
//                   and the print often arrives AFTER the price_change that removed the liquidity.
// Polymarket drops sockets a few times an hour ("1013 slow consumer"). On a drop every book is
// cleared and is not ready until its fresh snapshot arrives, so a gap never looks like a move.
//
// Sockets  PM_SOCKETS > 1 (CFG.pmSockets) opens that many sockets on the same tokens; each event counts from whichever
//          delivers it first. Why: one connection runs 50–90 ms behind another for whole windows now and then (10% of
//          the paper/challenger windows of 10-28..29, 2 of the 5 live windows of 10-23), while their perp stays aligned.
//          Every socket carries the venue's events in the same order, so for each level the updates seen so far, over
//          all sockets, are one prefix of its sequence: an update stamped before the level's last applied one is a
//          late copy (dropped); one with the same stamp whose (hash, size) was seen is a copy (dropped); anything else
//          is new (applied). Sizes are a level's new total, so a copy never adds. A `book` merges level by level under
//          the same rule (a level updated after the snapshot keeps its value), and a book that is not ready takes the
//          snapshot whole. Prints count once per arrival on the socket that has delivered that print most often, so a
//          print repeated on one socket still counts twice, and its copy on another socket does not. A drop clears the
//          books only when no socket is left up. A snapshot also states the levels it lacks: nothing stamped before the
//          token's newest snapshot counts (TokenBook.floor). Content dedupe alone failed the latency team's check (README "Latency
//          team", L3): it reordered updates of one level; the stamp guard is its amendment. Corner left: a socket that
//          joins mid-millisecond can skip that millisecond's earlier update of a level (prefix rule), until its next one.
import WebSocket from "ws";

const URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const key = (p: number) => Math.round(p * 10_000);
/** The book's level key for a price (1/100 of a cent), for OwnLevels. */
export const priceKey = key;

export type Level = [number, number];
export interface LastTrade { price: number; size: number; side: string; ts: number }
export interface Print extends LastTrade { asset: string; rx: number }

class TokenBook {
  bids = new Map<number, Level>();
  asks = new Map<number, Level>();
  ready = false;
  lastUpdate = 0;
  lastTrade: LastTrade | null = null;
  /** The tick from the CLOB's `tick_size_change` (null = none seen: the market's listed tick). Kept across a reconnect:
   *  it only ever goes 1¢ → 0.1¢ within a market. */
  tick: number | null = null;
  /** PM_SOCKETS > 1: per level (priceKey), the stamp of its last applied update and the (hash, size) keys seen at it;
   *  kept after a level is gone, so a late copy cannot bring it back. */
  seenB = new Map<number, Seen>();
  seenA = new Map<number, Seen>();
  /** PM_SOCKETS > 1: snapshots already merged ("stamp|hash"), so a copy skips the level walk. */
  books = new Set<string>();
  /** PM_SOCKETS > 1: the newest snapshot's stamp. A snapshot states every level, the ones it lacks too, so nothing
   *  stamped before it counts, on any level (per token and per level, the feed's stamps never go back: 0 of 1.2M
   *  updates in a 30-minute race, 2026-11-01). */
  floor = -Infinity;
  clear(): void { this.bids.clear(); this.asks.clear(); this.ready = false; this.seenB.clear(); this.seenA.clear(); this.books.clear(); this.floor = -Infinity; }
}

interface Seen { ts: number; keys: Set<string> }

/** One market socket. */
interface Sock {
  s: number;
  ws: WebSocket | null;
  up: boolean;
  backoff: number;
  lastRx: number;
  subscribedAt: Map<string, number>;
  /** Tokens whose snapshot this socket has delivered since it connected. */
  snap: Set<string>;
  /** Events whose first copy came from this socket (PM_SOCKETS > 1). */
  first: number;
  reconnects: number;
}

export interface BookView {
  ready: boolean;
  bids: Level[];          // best first
  asks: Level[];          // best first
  bestBid: number | null;
  bestAsk: number | null;
  ageMs: number | null;
  last: LastTrade | null;
  /** The tick in force from the CLOB's `tick_size_change`; null/absent = none seen, the market's listed tick applies. */
  tick?: number | null;
}

/** Our own resting size per level of one token's book, keyed by priceKey. MM_MODE=live: Polymarket shows our orders on the
 *  public feed, and the strategy must see the book without them, as the paper exchange does (liveExchange.own). */
export interface OwnLevels { bids: Map<number, number>; asks: Map<number, number> }

export class PmBookFeed {
  private own: ((asset: string) => OwnLevels | null) | null = null;
  private books = new Map<string, TokenBook>();
  private wanted: string[] = [];
  private readonly socks: Sock[];
  private lags: number[] = [];
  /** Every taken event's lag since the last minute() call (capped), and each socket's first copies then. */
  private lagMin: number[] = [];
  private firstMin: number[];
  private rate: number[] = [];
  private printSubs: ((p: Print) => void)[] = [];
  private bookSubs: ((asset: string, now: number) => void)[] = [];
  /** PM_SOCKETS > 1: per print key, how often each socket delivered it, and how often it was passed on. */
  private prints = new Map<string, { at: number; n: number[]; d: number }>();
  msgs = 0;
  reconnects = 0;
  lastRx = 0;
  lastError = "";

  constructor(private readonly log: (m: string) => void, private readonly n = 1) {
    this.socks = Array.from({ length: Math.max(1, n) }, (_, s) => ({ s, ws: null, up: false, backoff: 1000, lastRx: 0,
      subscribedAt: new Map(), snap: new Set(), first: 0, reconnects: 0 }));
    this.firstMin = this.socks.map(() => 0);
  }

  /** The heartbeat (engine.calibrate, once a minute): the taken events' exchange->local lag since the last call, and each
   *  socket's share of first copies (PM_SOCKETS > 1); then starts a new minute. */
  minute(): string {
    const l = this.lagMin.sort((a, b) => a - b), at = (p: number) => Math.round(l[Math.min(l.length - 1, Math.floor(p * l.length))]);
    const tot = this.firstMin.reduce((a, b) => a + b, 0);
    const out = (l.length ? `lag p50 ${at(0.5)} / p90 ${at(0.9)} / p99 ${at(0.99)} ms over ${l.length} events` : "no events") +
      (this.n > 1 ? ` · first copies ${this.socks.map((k, i) => `#${k.s}${k.up ? "" : " (down)"} ${tot ? Math.round((100 * this.firstMin[i]) / tot) : 0}%`).join(", ")}` : "");
    this.lagMin = []; this.firstMin = this.socks.map(() => 0);
    return out;
  }

  /** Any socket up. */
  get connected(): boolean { return this.socks.some((k) => k.up); }

  start(): void {
    for (const k of this.socks) this.connect(k);
    setInterval(() => {
      const now = Date.now();
      for (const [key, p] of this.prints) if (now - p.at > 60_000) this.prints.delete(key);
      for (const k of this.socks) {
        if (!k.up || !k.ws) continue;
        try { k.ws.send("PING"); } catch { /* */ }
        if (now - k.lastRx > 30_000) { this.kick(k, "no message for 30 s"); continue; }
        for (const id of this.wanted) {
          const at = k.subscribedAt.get(id);
          if (!k.snap.has(id) && at != null && now - at > 8000) { this.kick(k, `no snapshot for …${id.slice(-6)}`); break; }
        }
      }
    }, 10_000).unref();
  }

  private tag(k: Sock): string { return this.n > 1 ? `[pm-book#${k.s}]` : "[pm-book]"; }

  private kick(k: Sock, why: string): void {
    this.lastError = why;
    this.log(`${this.tag(k)} ${why}, reconnecting`);
    try { k.ws?.terminate(); } catch { /* close handler reconnects */ }
  }

  /** Subscribe to exactly these tokens. */
  setTokens(ids: string[]): void {
    const next = [...new Set(ids.filter(Boolean))].sort();
    if (next.join() === this.wanted.join()) return;
    const drop = this.wanted.filter((i) => !next.includes(i));
    const add = next.filter((i) => !this.wanted.includes(i));
    this.wanted = next;
    for (const i of drop) { this.books.delete(i); for (const k of this.socks) { k.subscribedAt.delete(i); k.snap.delete(i); } }
    for (const i of add) this.books.set(i, new TokenBook());
    const now = Date.now();
    for (const k of this.socks) {
      if (!k.up || !k.ws) continue;               // the (re)connect subscribes `wanted`
      if (drop.length) this.send(k, { assets_ids: drop, operation: "unsubscribe" });
      if (add.length) {
        this.send(k, { assets_ids: add, operation: "subscribe" });
        for (const i of add) k.subscribedAt.set(i, now);
      }
    }
  }

  view(id: string | null | undefined, depth = 15): BookView {
    const b = id ? this.books.get(id) : undefined;
    if (!b) return { ready: false, bids: [], asks: [], bestBid: null, bestAsk: null, ageMs: null, last: null, tick: null };
    const own = this.own?.(id!) ?? null;
    const bids = less([...b.bids.values()], own?.bids).sort((x, y) => y[0] - x[0]).slice(0, depth);
    const asks = less([...b.asks.values()], own?.asks).sort((x, y) => x[0] - y[0]).slice(0, depth);
    return {
      ready: b.ready, bids, asks,
      bestBid: bids.length ? bids[0][0] : null, bestAsk: asks.length ? asks[0][0] : null,
      ageMs: b.lastUpdate ? Date.now() - b.lastUpdate : null, last: b.lastTrade, tick: b.tick,
    };
  }

  /** Our own resting size to take out of every view and top (MM_MODE=live); null = none (paper, shadow). */
  setOwn(fn: ((asset: string) => OwnLevels | null) | null): void { this.own = fn; }

  /** Every trade print on a subscribed token, as it arrives (the paper exchange's fill tape). */
  onPrint(cb: (p: Print) => void): void { this.printSubs.push(cb); }

  /** After each socket message, once per token whose book it changed (a snapshot or price changes): the flow FV's
   *  order-flow imbalance steps once per update, as the offline panel did per same-millisecond group. */
  onBookUpdate(cb: (asset: string, now: number) => void): void { this.bookSubs.push(cb); }

  /** Best bid / ask and their sizes, without sorting the ladders (null = side empty or book not ready). */
  top(id: string): { bb: number | null; bs: number; ba: number | null; as: number } {
    const b = this.books.get(id);
    let bb: Level | null = null, ba: Level | null = null;
    if (b?.ready) {
      const own = this.own?.(id) ?? null;
      for (const l of less([...b.bids.values()], own?.bids)) if (!bb || l[0] > bb[0]) bb = l;
      for (const l of less([...b.asks.values()], own?.asks)) if (!ba || l[0] < ba[0]) ba = l;
    }
    return { bb: bb ? bb[0] : null, bs: bb ? bb[1] : 0, ba: ba ? ba[0] : null, as: ba ? ba[1] : 0 };
  }

  /** Exchange->local lag p50 / p90 / p99 (ms) over the last 500 events taken, messages per second over the last 5 s,
   *  and per socket (PM_SOCKETS > 1) whether it is up, its share of first copies and its reconnects. */
  stats(): { lagP50: number | null; lagP90: number | null; lagP99: number | null; rate: number; sockets?: { s: number; up: boolean; first: number; reconnects: number }[] } {
    const now = Date.now();
    while (this.rate.length && this.rate[0] < now - 5000) this.rate.shift();
    const l = [...this.lags].sort((a, b) => a - b), at = (p: number) => (l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : null);
    const out = { lagP50: l.length ? l[l.length >> 1] : null, lagP90: at(0.9), lagP99: at(0.99), rate: this.rate.length / 5 };
    if (this.n === 1) return out;
    const tot = this.socks.reduce((a, k) => a + k.first, 0);
    return { ...out, sockets: this.socks.map((k) => ({ s: k.s, up: k.up, first: tot ? Math.round((k.first / tot) * 1000) / 1000 : 0, reconnects: k.reconnects })) };
  }

  private send(k: Sock, m: unknown): void {
    try { k.ws?.send(typeof m === "string" ? m : JSON.stringify(m)); } catch (e) { this.lastError = `send: ${(e as Error).message}`; }
  }

  private connect(k: Sock): void {
    const ws = new WebSocket(URL);
    k.ws = ws;
    ws.on("open", () => {
      k.up = true; k.backoff = 1000; k.lastRx = this.lastRx = Date.now();
      const now = Date.now();
      for (const i of this.wanted) k.subscribedAt.set(i, now);
      if (this.wanted.length) this.send(k, { assets_ids: this.wanted, type: "market" });
      this.log(`${this.tag(k)} connected, ${this.wanted.length} token(s)`);
    });
    ws.on("message", (data) => {
      const body = data.toString();
      const now = Date.now();
      k.lastRx = this.lastRx = now;
      if (body === "PONG") return;
      try { this.apply(body, now, k.s); } catch (e) { this.lastError = `bad message: ${(e as Error).message}`; }
    });
    const down = (why: string) => {
      if (k.ws !== ws) return;
      k.ws = null;
      this.dropped(k, why);
      setTimeout(() => this.connect(k), k.backoff).unref();
      k.backoff = Math.min(k.backoff * 2, 30_000);
    };
    ws.on("close", (c, r) => down(`close ${c}${r?.length ? " " + r.toString() : ""}`));
    ws.on("error", (e) => { try { ws.terminate(); } catch { /* */ } down(e.message); });
  }

  /** A socket went down: the books are cleared only when no other socket is up (they keep the books current). */
  private dropped(k: Sock, why: string): void {
    k.up = false; k.reconnects++; this.reconnects++; this.lastError = why;
    k.subscribedAt.clear(); k.snap.clear();
    const left = this.socks.filter((o) => o.up).length;
    if (!left) for (const b of this.books.values()) b.clear();
    this.log(`${this.tag(k)} down (${why}), reconnecting in ${Math.round(k.backoff / 1000)} s` + (this.n > 1 ? (left ? `; ${left} socket(s) still up, books kept` : "; no socket up, books cleared") : ""));
  }

  /** PM_SOCKETS > 1: whether an update of one level at stamp ts with this (hash, size) key is new (the "Sockets" rule). */
  private fresh(b: TokenBook, bid: boolean, k: number, ts: number, key: string): boolean {
    if (!Number.isFinite(ts)) return true;
    const m = bid ? b.seenB : b.seenA, st = m.get(k);
    if (ts < Math.max(st?.ts ?? -Infinity, b.floor)) return false;
    if (!st || ts > st.ts) { m.set(k, { ts, keys: new Set([key]) }); return true; }
    if (st.keys.has(key)) return false;
    st.keys.add(key);
    return true;
  }

  /** PM_SOCKETS > 1: a `book` merged level by level; true if any level changed hands. */
  private merge(b: TokenBook, ev: { bids?: { price: unknown; size: unknown }[]; asks?: { price: unknown; size: unknown }[]; hash?: unknown }, ts: number): boolean {
    let took = false;
    for (const [bid, side, levels] of [[true, b.bids, ev.bids ?? []], [false, b.asks, ev.asks ?? []]] as const) {
      const inSnap = new Set<number>();
      for (const l of levels) {
        const p = Number(l.price); if (!Number.isFinite(p)) continue;
        const k = key(p); inSnap.add(k);
        if (this.fresh(b, bid, k, ts, `${ev.hash ?? ""}|${l.size}`)) { put(side, l.price, l.size); took = true; }
      }
      for (const k of [...side.keys()]) if (!inSnap.has(k) && this.fresh(b, bid, k, ts, `${ev.hash ?? ""}|0`)) { side.delete(k); took = true; }
    }
    return took;
  }

  /** Public so the self-test can drive it without a socket; s = the socket it came from. */
  apply(body: string, now: number, s = 0): void {
    const parsed = JSON.parse(body);
    const touched = this.bookSubs.length ? new Set<string>() : null;
    const multi = this.n > 1;
    for (const ev of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!ev || typeof ev !== "object") continue;
      const exTs = Number(ev.timestamp);
      const count = () => {
        this.msgs++;
        if (this.rate.length < 20_000) this.rate.push(now);
        if (Number.isFinite(exTs) && exTs > 0) {
          this.lags.push(now - exTs); if (this.lags.length > 500) this.lags.shift();
          if (this.lagMin.length < 200_000) this.lagMin.push(now - exTs);
        }
      };
      if (!multi) count();
      let took = !multi;
      const et = ev.event_type;
      if (et === "book") {
        const b = this.books.get(String(ev.asset_id));
        this.socks[s]?.snap.add(String(ev.asset_id));
        if (!b) continue;
        const id = `${ev.timestamp}|${ev.hash ?? ""}`;
        if (!multi || !b.ready) {
          b.bids.clear(); b.asks.clear();
          if (multi) { b.seenB.clear(); b.seenA.clear(); b.books.clear(); b.floor = Number.isFinite(exTs) ? exTs : -Infinity; }
          for (const l of ev.bids ?? []) { put(b.bids, l.price, l.size); if (multi) this.fresh(b, true, key(Number(l.price)), exTs, `${ev.hash ?? ""}|${l.size}`); }
          for (const l of ev.asks ?? []) { put(b.asks, l.price, l.size); if (multi) this.fresh(b, false, key(Number(l.price)), exTs, `${ev.hash ?? ""}|${l.size}`); }
          took = true;
        } else if (!b.books.has(id)) { took = this.merge(b, ev, exTs); if (exTs > b.floor) b.floor = exTs; }
        if (multi) { b.books.add(id); if (b.books.size > 64) b.books.delete(b.books.values().next().value!); }
        if (took) { b.ready = true; b.lastUpdate = now; touched?.add(String(ev.asset_id)); }
      } else if (et === "price_change") {
        for (const ch of ev.price_changes ?? ev.changes ?? []) {
          const b = this.books.get(String(ch.asset_id ?? ev.asset_id ?? ""));
          if (!b || !b.ready) continue;
          const bid = String(ch.side).toUpperCase() === "BUY";
          if (multi && !this.fresh(b, bid, key(Number(ch.price)), exTs, `${ch.hash ?? ""}|${ch.size}`)) continue;
          put(bid ? b.bids : b.asks, ch.price, ch.size);
          b.lastUpdate = now; took = true;
          touched?.add(String(ch.asset_id ?? ev.asset_id ?? ""));
        }
      } else if (et === "tick_size_change") {
        // 1¢ → 0.1¢, once per market, at no fixed price or time: of 4,683 recorded windows (2026-09-24 → 10-11) a third
        // had it before the close, and the book had been beyond 96¢ / 4¢ a median 2 min before it fired
        const b = this.books.get(String(ev.asset_id)), t = Number(ev.new_tick_size);
        if (b && t > 0) { took ||= b.tick !== t; b.tick = t; }
      } else if (et === "last_trade_price") {
        const b = this.books.get(String(ev.asset_id));
        if (!b) continue;
        if (multi) {
          const pk = `${ev.asset_id}|${ev.timestamp}|${ev.price}|${ev.size}|${ev.side}|${ev.transaction_hash ?? ev.hash ?? ""}`;
          let e = this.prints.get(pk);
          if (!e) this.prints.set(pk, (e = { at: now, n: new Array(this.n).fill(0), d: 0 }));
          if (++e.n[s] <= e.d) continue;
          e.d++; took = true;
        }
        b.lastTrade = { price: Number(ev.price), size: Number(ev.size), side: String(ev.side).toUpperCase(), ts: Number.isFinite(exTs) ? exTs : now };
        if (Number.isFinite(b.lastTrade.price) && b.lastTrade.size > 0) {
          const p: Print = { ...b.lastTrade, asset: String(ev.asset_id), rx: now };
          for (const cb of this.printSubs) { try { cb(p); } catch { /* */ } }
        }
      }
      // PM_SOCKETS > 1: counted once, from the socket that delivered it first, so the lag is the merged book's
      if (multi && took) { count(); if (this.socks[s]) { this.socks[s].first++; this.firstMin[s]++; } }
    }
    if (touched) for (const a of touched) for (const cb of this.bookSubs) { try { cb(a, now); } catch { /* */ } }
  }
}

/** The levels less our own size at each; a level left with nothing is dropped. */
function less(levels: Level[], own: Map<number, number> | undefined): Level[] {
  if (!own?.size) return levels;
  const out: Level[] = [];
  for (const l of levels) {
    const o = own.get(key(l[0]));
    if (!o) out.push(l);
    else if (l[1] - o > 1e-6) out.push([l[0], l[1] - o]);
  }
  return out;
}

function put(side: Map<number, Level>, price: unknown, size: unknown): void {
  const p = Number(price), s = Number(size);
  if (!Number.isFinite(p)) return;
  if (!Number.isFinite(s) || s <= 0) side.delete(key(p));
  else side.set(key(p), [p, s]);
}
