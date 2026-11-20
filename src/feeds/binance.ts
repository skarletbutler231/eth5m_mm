// Binance <asset>USDT (asset.ts: ETHUSDT) best bid/offer -> mid, sub-second. Binance leads Chainlink, so it nowcasts the
// Chainlink price between Chainlink prints, and its 1 s returns are the sigma input. Mids are stamped
// with local receive time. The same class carries the USD-M perp (PERP_URL, no REST backfill): the flow FV's
// strongest input, its book leading spot by a few hundred ms (arrives ~131 ms after its stamp, measured 2026-10-12).
//
// CryptoStruct relay (CRYPTOSTRUCT_FEEDS, https://cryptostruct.com/docs/realtime.md): the same top of book from Binance
// carried over CryptoStruct's backbone to a London proxy (lon1, ~16 ms from this box) instead of Binance's own Tokyo
// sockets (~100 ms of wire, README "CryptoStruct feed check" 2026-11-01). One source at a time feeds the buffer:
// the relay when it is up, the direct socket otherwise (no key, handshake refused, the paid day ended, 3 failed
// connects in a row), retried every CS_RETRY_MS. Both sources are never merged — their messages share no id we have
// checked, so a late direct mid could land after a fresher relayed one.
import WebSocket from "ws";
import { ASSET } from "../asset.js";
import { PriceBuffer } from "../model/priceBuffer.js";

const WS_URL = `wss://stream.binance.com:9443/ws/${ASSET.binance.toLowerCase()}@bookTicker`;
export const PERP_URL = `wss://fstream.binance.com/ws/${ASSET.binance.toLowerCase()}@bookTicker`;
const REST = "https://api.binance.com/api/v3/klines";

/** A CryptoStruct realtime endpoint for this feed (the port selects the market: 14004 binance_swap, 14003 binance_spot). */
export interface CsSource {
  host: string;
  port: number;
  market: "binance_swap" | "binance_spot";
  /** The CRYPTOSTRUCT_REALTIME_API_KEY. It travels in the socket URL: never log the URL. */
  key: string;
  /** The numeric instrument id (67824 = BTCUSDT perp); null = looked up in the instrument directory by code ASSET.binance. */
  id: number | null;
  /** Login [13, org, app, version, processId]: free-form, for the vendor's logs only. */
  login: [string, string, string, string];
}

/** After a refused handshake, a server notice or 3 failed connects in a row, the direct socket runs this long before the
 *  relay is tried again (a refused key re-validates at the next login once a day is bought). */
const CS_RETRY_MS = 10 * 60_000;
const CS_MAX_FAILS = 3;

export class BinanceFeed {
  /** 20 minutes of mids, coalesced to 2 ms. */
  readonly mids = new PriceBuffer(20 * 60_000, 2);
  connected = false;
  msgs = 0;
  reconnects = 0;
  lastRx = 0;
  lastError = "";
  /** The source feeding the buffer now. */
  src: "binance" | "cryptostruct" = "binance";
  private ws: WebSocket | null = null;
  private rate: number[] = [];
  private lastMid = NaN;
  private midSubs: ((now: number) => void)[] = [];
  /** Exchange stamp -> receipt (ms) of the last 500 updates of the current source (the direct spot ticker carries none). */
  private lat: number[] = [];
  private csFails = 0;
  private csBlockedUntil = 0;
  /** A relay socket opened while the direct one still feeds (the retry), until its first top of book. */
  private probe: WebSocket | null = null;

  constructor(private readonly log: (m: string) => void, private readonly url = WS_URL, private readonly name = "binance",
              private readonly backfill = true, private cs: CsSource | null = null) {}

  /** Called on every message whose mid differs from the last one (MM_DECIDE_EVENTS=all). */
  onMid(cb: (now: number) => void): void { this.midSubs.push(cb); }

  /** The last hour of REST 1 s closes fetched at boot (also seeds the vol EWMAs). */
  seed1s: { sec: number; px: number }[] = [];

  async start(): Promise<void> {
    // Backfill 20 minutes of the mid buffer from 1 s bars BEFORE the socket opens (the buffer only
    // accepts increasing timestamps). Without it a bot started mid-window cannot price the realised
    // part of the averaging window or measure the basis until a minute of live data has accrued.
    if (this.backfill) try {
      const now = Date.now();
      this.seed1s = await this.closes1s(now - 3600_000, now);
      let n = 0;
      for (const p of this.seed1s) if (p.sec * 1000 >= now - 20 * 60_000 && p.sec * 1000 <= now) { this.mids.push(p.sec * 1000, p.px); n++; }
      this.log(`[${this.name}] backfilled ${n} s of mids from REST 1 s bars`);
    } catch (e) { this.log(`[${this.name}] backfill failed: ${(e as Error).message}`); }
    if (this.cs && this.cs.id == null) try {
      this.cs.id = await this.lookupId(this.cs);
    } catch (e) {
      this.log(`[${this.name}] CryptoStruct ${this.cs.market}: ${(e as Error).message}, direct Binance only`);
      this.cs = null;
    }
    if (this.cs) this.log(`[${this.name}] source: CryptoStruct ${this.cs.market} instrument ${this.cs.id} at ${this.cs.host}:${this.cs.port}, ` +
      `direct Binance as the fallback`);
    this.connect();
    setInterval(() => {
      const now = Date.now();
      if (this.connected && now - this.lastRx > 15_000) {
        this.lastError = "no message for 15 s";
        this.log(`[${this.name}] ${this.lastError}, reconnecting`);
        try { this.ws?.terminate(); } catch { /* close handler reconnects */ }
      } else if (this.cs?.id != null && this.src === "binance" && this.connected && !this.probe && now >= this.csBlockedUntil) {
        // back to the relay, make-before-break: the direct socket keeps feeding until the relay's first top of book, so a
        // still-refused key (the day ended, none bought) costs no gap
        this.log(`[${this.name}] retrying CryptoStruct`);
        this.connectCs(this.cs as CsSource & { id: number }, true);
      }
    }, 5_000).unref();
  }

  /** 1 s closes over [fromMs, toMs] from REST (1000 bars per call), for warming the vol EWMAs. */
  async closes1s(fromMs: number, toMs: number): Promise<{ sec: number; px: number }[]> {
    const out: { sec: number; px: number }[] = [];
    let start = Math.floor(fromMs / 1000) * 1000;
    while (start < toMs) {
      const r = await fetch(`${REST}?symbol=${ASSET.binance}&interval=1s&startTime=${start}&endTime=${toMs}&limit=1000`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = (await r.json()) as unknown[][];
      if (!rows.length) break;
      for (const k of rows) out.push({ sec: Number(k[0]) / 1000 + 1, px: Number(k[4]) });   // close = price at the end of that second
      start = Number(rows[rows.length - 1][0]) + 1000;
      if (rows.length < 1000) break;
    }
    return out;
  }

  /**
   * Binance 1-second klines over [aMs, bMs] as a step series — the fallback strike when the process
   * was not running across a window's opening minute. Trade closes, not mids: ~0.1 bps apart.
   */
  async meanFromRest(aMs: number, bMs: number): Promise<number | null> {
    const url = `${REST}?symbol=${ASSET.binance}&interval=1s&startTime=${Math.floor(aMs / 1000) * 1000 - 1000}&endTime=${Math.ceil(bMs / 1000) * 1000}&limit=1000`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const rows = (await r.json()) as unknown[][];
    const buf = new PriceBuffer(10 * 60_000);
    // a 1 s bar's close holds from the END of that second
    for (const k of rows) buf.push(Number(k[0]) + 1000, Number(k[4]));
    return buf.mean(aMs, bMs);
  }

  msgRate(): number {
    const now = Date.now();
    while (this.rate.length && this.rate[0] < now - 5000) this.rate.shift();
    return this.rate.length / 5;
  }

  /** Median of exchange stamp -> receipt over the recent updates of the current source (ms). */
  lagP50(): number | null {
    if (!this.lat.length) return null;
    const s = [...this.lat].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /** One top of book from either source. exchMs = the venue's stamp (ms), NaN when the message has none. */
  private onTop(now: number, bid: number, ask: number, exchMs: number): void {
    if (!(bid > 0 && ask > 0)) return;
    if (exchMs > 0) { this.lat.push(now - exchMs); if (this.lat.length > 500) this.lat.shift(); }
    const mid = (bid + ask) / 2;
    this.mids.push(now, mid);
    if (mid !== this.lastMid) { this.lastMid = mid; for (const cb of this.midSubs) { try { cb(now); } catch { /* */ } } }
  }

  private connect(): void {
    if (this.probe) { const p = this.probe; this.probe = null; try { p.terminate(); } catch { /* */ } }
    if (this.cs?.id != null && Date.now() >= this.csBlockedUntil) this.connectCs(this.cs as CsSource & { id: number });
    else this.connectDirect();
  }

  /** A socket went down: the next one after a delay. CryptoStruct: "hard" (key refused, day ended, instrument refused) or
   *  the 3rd failure in a row hands over to the direct socket for CS_RETRY_MS; a single failure retries the relay. A failed
   *  retry from the direct socket (the probe) just waits another CS_RETRY_MS, the direct socket untouched. */
  private down(ws: WebSocket, why: string, hard = false): void {
    if (this.probe === ws) {
      this.probe = null; this.csBlockedUntil = Date.now() + CS_RETRY_MS;
      this.log(`[${this.name}] CryptoStruct retry failed (${why}): direct Binance for ${CS_RETRY_MS / 60_000} more min`);
      return;
    }
    if (this.ws !== ws) return;
    this.ws = null; this.connected = false; this.reconnects++; this.lastError = why;
    let delay = 2000;
    if (this.src === "cryptostruct") {
      this.csFails++;
      if (hard || this.csFails >= CS_MAX_FAILS) {
        this.csBlockedUntil = Date.now() + CS_RETRY_MS; this.csFails = 0;
        this.log(`[${this.name}] CryptoStruct down (${why}): direct Binance for ${CS_RETRY_MS / 60_000} min`);
        this.connect();   // the direct socket at once, not after the delay
        return;
      }
      delay = 1000 * this.csFails;
    }
    this.log(`[${this.name}] down (${why}), reconnecting in ${delay / 1000} s`);
    setTimeout(() => this.connect(), delay).unref();
  }

  private connectDirect(): void {
    // no permessage-deflate (ws offers it by default): compressed perp sockets ran p90 21–42 ms behind plain ones in the
    // 2026-10-28 crossover races, seconds behind on a loaded box (README "Latency team", L7)
    const ws = new WebSocket(this.url, { perMessageDeflate: false });
    this.ws = ws;
    if (this.src !== "binance") { this.src = "binance"; this.lat = []; }
    ws.on("open", () => { this.connected = true; this.lastRx = Date.now(); this.log(`[${this.name}] connected`); });
    ws.on("message", (buf) => {
      if (this.ws !== ws) return;
      const now = Date.now();
      this.lastRx = now; this.msgs++;
      if (this.rate.length < 5000) this.rate.push(now);
      let j: { b?: string; a?: string; T?: number; E?: number };
      try { j = JSON.parse(buf.toString()); } catch { return; }
      // perp: T = matching-engine time (CryptoStruct's binance_swap stamp is the same kind); spot bookTicker has no stamp
      this.onTop(now, Number(j.b), Number(j.a), Number(j.T ?? j.E ?? NaN));
    });
    ws.on("close", (c) => this.down(ws, `close ${c}`));
    ws.on("error", (e) => { try { ws.terminate(); } catch { /* */ } this.down(ws, e.message); });
  }

  /** The instrument id of ASSET.binance in the market's directory (key as a Bearer header, never in the URL). */
  private async lookupId(cs: CsSource): Promise<number> {
    const r = await fetch(`https://cryptostruct.com/api/realtime/instruments?market=${cs.market}`,
      { headers: { Authorization: `Bearer ${cs.key}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`instrument directory HTTP ${r.status}`);
    const d = (await r.json()) as { instruments: { instrument_id: number; code: string; state: string }[] };
    const row = d.instruments.find((x) => x.code === ASSET.binance && (x.state === "open" || x.state === "review"));
    if (!row) throw new Error(`${ASSET.binance} not in the ${cs.market} directory`);
    return row.instrument_id;
  }

  /** probe = a retry from the direct socket: it takes over (this.ws, src) on its first top of book, the direct socket
   *  feeding until then. */
  private connectCs(cs: CsSource & { id: number }, probe = false): void {
    const id = cs.id;
    if (!probe && this.src !== "cryptostruct") { this.src = "cryptostruct"; this.lat = []; }
    const sock = new WebSocket(`ws://${cs.host}:${cs.port}/api/v6?apiKey=${encodeURIComponent(cs.key)}`,
      { perMessageDeflate: false, handshakeTimeout: 5000 });
    if (probe) {
      this.probe = sock;
      setTimeout(() => { if (this.probe === sock) { try { sock.terminate(); } catch { /* */ } this.down(sock, "no top of book in 10 s"); } }, 10_000).unref();
    } else this.ws = sock;
    let ready = false;
    // 401/403 at the upgrade: "api key rejected: <reason>" (unknown key, no paid day for this market today). With this
    // listener attached ws does not close the socket itself, so the handler takes it down. The proxy often resets the
    // connection before the body is read (ECONNRESET on the socket), so the status, not the body, makes it a hard stop.
    let refused = 0, body = "";
    const refusal = () => `handshake HTTP ${refused}${body ? `: ${body.trim()}` : ""}`;
    sock.on("unexpected-response", (req, res) => {
      refused = res.statusCode ?? 0;
      const fin = () => { this.down(sock, refusal(), refused === 401 || refused === 403); req.destroy(); };
      res.on("data", (c: Buffer) => { if (body.length < 300) body += c.toString(); });
      res.on("end", fin);
      res.on("error", fin);
    });
    sock.on("open", () => {
      if (this.ws === sock) { this.connected = true; this.lastRx = Date.now(); }
      sock.send(JSON.stringify([13, ...cs.login]));   // login first: a subscribe before it closes the connection
    });
    sock.on("message", (buf, isBinary) => {
      if (this.ws !== sock && this.probe !== sock) return;
      const now = Date.now();
      if (this.ws === sock) this.lastRx = now;
      const text = isBinary ? "" : buf.toString();
      if (text[0] !== "[") {
        // a plain-text notice right before the server closes: "api key expired or revoked" (the paid day ended at
        // 00:00 UTC or the key was rotated), "pong check failed", "service shutdown", ...
        this.log(`[${this.name}] CryptoStruct notice: ${text.slice(0, 200)}`);
        try { sock.terminate(); } catch { /* */ }
        this.down(sock, `notice: ${text.slice(0, 80)}`, /expired|revoked|not logged in|protocol violation/.test(text));
        return;
      }
      let m: unknown[];
      try { m = JSON.parse(text); } catch { return; }
      switch (m[0]) {
        case 6: {   // top of book: [6, id, prevEventId, eventId, adapterTsNs, exchangeTsNs, [[side, "px", "qty", count], ...]]
          if (this.probe === sock) {   // the retry delivers: it replaces the direct socket
            const old = this.ws;
            this.ws = sock; this.probe = null; this.src = "cryptostruct"; this.lat = []; this.connected = true; this.lastRx = now;
            try { old?.terminate(); } catch { /* its handlers see this.ws !== old */ }
            this.log(`[${this.name}] back on CryptoStruct`);
          }
          this.msgs++;
          if (this.rate.length < 5000) this.rate.push(now);
          let bid = NaN, ask = NaN;
          for (const l of m[6] as [number, string, string, number][]) { if (l[0] === 0) bid = Number(l[1]); else if (l[0] === 1) ask = Number(l[1]); }
          // Only the latest top of book matters here, so no prevEventId check (the ids are shared with the book topic,
          // which is not subscribed, so they do not chain anyway)
          this.onTop(now, bid, ask, Number(m[5]) / 1e6);
          if (!ready) { ready = true; this.csFails = 0; }
          break;
        }
        case 14:    // login answered: subscribe the top of book alone, every change (no coalescing)
          sock.send(JSON.stringify([11, id, { depthTopic: false, topOfBookTopic: true, tradesTopic: false, markPriceTopic: false,
            indexPriceTopic: false, fundingRateTopic: false, liquidationsTopic: false, topOfBookCoalescing: false }]));
          break;
        case 5:     // instrument state: [5, id, tsNs, "READY" | "ERROR", "message"]
          if (m[3] === "READY") this.log(`[${this.name}] connected (CryptoStruct ${cs.host.split(".")[0]}, instrument ${id})`);
          else {
            this.log(`[${this.name}] CryptoStruct instrument ${id}: ${String(m[3])} ${String(m[4] ?? "")}`);
            try { sock.terminate(); } catch { /* */ }
            this.down(sock, `instrument ${String(m[3])}: ${String(m[4] ?? "")}`.slice(0, 120), true);
          }
          break;
        default: break;   // unknown tags are ignored (the spec may add types)
      }
    });
    sock.on("close", (c) => this.down(sock, refused ? refusal() : `close ${c}`, refused === 401 || refused === 403));
    sock.on("error", (e) => {
      try { sock.terminate(); } catch { /* */ }
      this.down(sock, refused ? refusal() : e.message, refused === 401 || refused === 403);
    });
  }
}
