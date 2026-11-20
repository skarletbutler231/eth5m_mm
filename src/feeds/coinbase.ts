// Coinbase <asset>-USD (asset.ts: ETH-USD) top of book over the public Advanced Trade socket (level2, no key) -> mid buffer.
// The second nowcast venue next to Binance. Coinbase trades against USD, and Chainlink BTC/USD sat within
// ~0.1 bps of it (Binance USDT ~9 bps above). It reaches this box ~95 ms after its stamp against Binance's
// ~135 ms. Measured 2026-10-09 over an hour: alone it explains Chainlink's next print worse than Binance
// (20-29% of the move vs 69%), but blended in at ~25% it cut the nowcast error ~18% out of sample. The
// weight and lag are calibrated live (calibration.ts). Mids are stamped with local receive time.
//
// The book is rebuilt from the level2 snapshot plus updates. sequence_num counts every message on the
// connection across all channels, so a gap means a lost update: reconnect for a fresh snapshot.
import WebSocket from "ws";
import { ASSET } from "../asset.js";
import { PriceBuffer } from "../model/priceBuffer.js";

const WS_URL = "wss://advanced-trade-ws.coinbase.com";
const PRODUCT = ASSET.coinbase;

/** Best bid and ask of a level2 book kept from a snapshot plus updates. */
export class L2Top {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  bid = 0;
  ask = Infinity;

  reset(): void { this.bids.clear(); this.asks.clear(); this.bid = 0; this.ask = Infinity; }

  /** One level: qty 0 removes it. Removing the best level rescans that side. */
  set(side: "bid" | "offer", price: number, qty: number): void {
    if (!(price > 0) || !Number.isFinite(qty)) return;
    if (side === "bid") {
      if (qty > 0) { this.bids.set(price, qty); if (price > this.bid) this.bid = price; }
      else if (this.bids.delete(price) && price === this.bid) { this.bid = 0; for (const p of this.bids.keys()) if (p > this.bid) this.bid = p; }
    } else {
      if (qty > 0) { this.asks.set(price, qty); if (price < this.ask) this.ask = price; }
      else if (this.asks.delete(price) && price === this.ask) { this.ask = Infinity; for (const p of this.asks.keys()) if (p < this.ask) this.ask = p; }
    }
  }

  get crossed(): boolean { return this.bid > 0 && this.ask < Infinity && this.bid >= this.ask; }
  mid(): number | null { return this.bid > 0 && this.ask < Infinity && !this.crossed ? (this.bid + this.ask) / 2 : null; }
}

export class CoinbaseFeed {
  /** 20 minutes of mids, coalesced to 2 ms. */
  readonly mids = new PriceBuffer(20 * 60_000, 2);
  connected = false;
  msgs = 0;
  reconnects = 0;
  lastRx = 0;
  lastError = "";
  private ws: WebSocket | null = null;
  private top = new L2Top();
  private seq = -1;
  private snapshot = false;
  private crossedSince: number | null = null;
  private rate: number[] = [];
  private lat: number[] = [];     // rx - exchange event time of recent updates (ms)

  constructor(private readonly log: (m: string) => void) {}

  start(): void {
    this.connect();
    setInterval(() => {
      const now = Date.now();
      const why = this.connected && now - this.lastRx > 10_000 ? "no message for 10 s"
        : this.crossedSince != null && now - this.crossedSince > 3000 ? "book crossed for 3 s" : "";
      if (!why) return;
      this.lastError = why;
      this.log(`[coinbase] ${why}, reconnecting`);
      try { this.ws?.terminate(); } catch { /* close handler reconnects */ }
    }, 2_000).unref();
  }

  /** Usable for pricing: connected, snapshot in, a message within 5 s and a sane top of book. */
  fresh(now: number): boolean {
    return this.connected && this.snapshot && now - this.lastRx < 5000 && this.top.mid() != null;
  }

  msgRate(): number {
    const now = Date.now();
    while (this.rate.length && this.rate[0] < now - 5000) this.rate.shift();
    return this.rate.length / 5;
  }

  /** Median of exchange stamp -> receipt over the recent updates (ms). */
  lagP50(): number | null {
    if (!this.lat.length) return null;
    const s = [...this.lat].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  private connect(): void {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    this.seq = -1; this.snapshot = false; this.crossedSince = null; this.top.reset();
    ws.on("open", () => {
      this.connected = true; this.lastRx = Date.now();
      for (const channel of ["level2", "heartbeats"]) ws.send(JSON.stringify({ type: "subscribe", product_ids: [PRODUCT], channel }));
      this.log("[coinbase] connected");
    });
    ws.on("message", (buf) => {
      if (this.ws !== ws) return;
      const now = Date.now();
      this.lastRx = now; this.msgs++;
      if (this.rate.length < 5000) this.rate.push(now);
      let m: { channel?: string; sequence_num?: number; events?: { type?: string; updates?: { side: "bid" | "offer"; event_time: string; price_level: string; new_quantity: string }[] }[] };
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (typeof m.sequence_num === "number") {
        if (this.seq >= 0 && m.sequence_num !== this.seq + 1) {
          this.lastError = `sequence gap ${this.seq} -> ${m.sequence_num}`;
          this.log(`[coinbase] ${this.lastError}, reconnecting for a fresh snapshot`);
          try { ws.terminate(); } catch { /* */ }
          return;
        }
        this.seq = m.sequence_num;
      }
      if (m.channel !== "l2_data" || !m.events) return;
      let ev = 0;
      for (const e of m.events) {
        if (e.type === "snapshot") { this.top.reset(); this.snapshot = true; }
        const upd = e.type === "update";
        for (const u of e.updates ?? []) {
          this.top.set(u.side, Number(u.price_level), Number(u.new_quantity));
          if (upd) { const t = Date.parse(u.event_time); if (t > ev) ev = t; }
        }
      }
      if (ev > 0) { this.lat.push(now - ev); if (this.lat.length > 200) this.lat.shift(); }
      if (!this.snapshot) return;
      if (this.top.crossed) { this.crossedSince ??= now; return; }
      this.crossedSince = null;
      const mid = this.top.mid();
      if (mid != null && mid !== this.mids.last()) this.mids.push(now, mid);
    });
    const down = (why: string) => {
      if (this.ws !== ws) return;
      this.ws = null; this.connected = false; this.reconnects++; this.lastError = why;
      this.log(`[coinbase] down (${why}), reconnecting in 2 s`);
      setTimeout(() => this.connect(), 2000).unref();
    };
    ws.on("close", (c) => down(`close ${c}`));
    ws.on("error", (e) => { try { ws.terminate(); } catch { /* */ } down(e.message); });
  }
}
