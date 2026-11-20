// Dashboard server: static page, small JSON API, and the /ws frame push.
//   GET /                    public/index.html (re-read per request, so page edits need no restart)
//   GET /api/status          feed health, calibration, aggregate score
//   GET /api/windows?date=   recorded windows for a UTC day (+ the live one)
//   GET /api/windows/:ts     one window's full 100 ms series for replay
//   POST /api/paper/reset    {start}: fresh paper account (paper only; same-origin only)
//   POST /api/pnl/reset      PnL restarts at zero, paper or live: cash, inventory and orders stay (same-origin only)
//   GET  /api/live/wallet    live: the wallet's collateral now, the booked cash, and whether a sync may run
//   POST /api/live/sync      live: the wallet minus the booked cash is booked as a deposit; PnL stays (same-origin only)
//   GET  /api/live/profile   live: the header's OWN | BASE | CHALLENGER switch (profile.ts): which config it follows, each one's knobs
//   POST /api/live/profile   live: {profile}: follow that config from the next window (same-origin only)
//   GET  /api/control        the panel's order size switch (10 | 20 | 40, cap 2×) and the header's STOP / START (control.ts)
//   POST /api/control        {size} from the next window and/or {stopped: true|false} at once (same-origin only)
//   GET /api/hour-regime     MM_HOUR_REGIME (hourRegime.ts): the hour → regime table, its knobs, mode, the last 48 windows' regimes
//   GET /api/twin            the header's PAPER | LIVE switch: this bot's other half (CFG.twinPort) and whether it answers
//   WS  /ws                  hello (current window so far) then one frame every UI_PUSH_MS
//   WS  /signal              big target-quote moves for other bots (signal.ts): hello, then "move" the moment one fires
//                            and "hb" every SIGNAL_HEARTBEAT_MS
//   WS  /signal-fills        this bot's own maker fills, no cancel sent / race cancel in flight (FILL_SIGNAL, signal.ts)
//   WS  /signal-fast         the same from the fast detector (FAST_SIGNAL_*: 5¢ in 100 ms), each message "signal": "fast"
//   WS  /signal-pair         the same from the pair trade's detector (PAIR_*), every signal it fires, "signal": "pair";
//                            only a pair app (PAIR_TRADE=on) has one, elsewhere it heartbeats unarmed
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { CFG, ROOT } from "./config.js";
import { ASSET, app } from "./asset.js";
import type { Engine } from "./engine.js";
import { FEEDS, FILL_FEED, type Feed } from "./signal.js";
import { profileStatus, requestProfile } from "./profile.js";

/** The other half of this bot's paper/live pair, as the header's PAPER | LIVE switch shows it. */
export interface Twin {
  self: "paper" | "live"; mode: "paper" | "live"; port: number;
  up: boolean; equity: number | null; pnl: number | null; halted: string | null;
  /** Not up: why. */
  why: string | null;
  /** The command that starts it. */
  start: string;
  at: number;
}

/** The twin from its /api/status (or the error asking for it): up only when it answers as the other mode of the same bot,
 *  the market maker's twin a market maker and the pair trade's a pair trade (a bot older than `pairTrade` is taken as it). */
export function twinOf(self: "paper" | "live", port: number, pair: boolean, st: unknown, err: string | null, now: number): Twin {
  const mode = self === "live" ? "paper" : "live";
  const start = mode === "live" ? `bash tools/start-live.sh${pair ? ` ${app("pair-live")}` : ""}`
    : `pm2 start ecosystem.config.cjs --only ${app(pair ? "pair" : "mm-bot")}`;
  const t: Twin = { self, mode, port, up: false, equity: null, pnl: null, halted: null, why: null, start, at: now };
  const s = st as { pairTrade?: boolean; paper?: { mode?: string; equity?: number; start?: number; live?: { halted?: string | null } } } | null;
  if (err || !s) return { ...t, why: err ?? `:${port} sent no status` };
  if (s.paper?.mode !== mode) return { ...t, why: `:${port} answers as MM_MODE=${s.paper?.mode ?? "?"}, not ${mode}` };
  if (s.pairTrade !== undefined && s.pairTrade !== pair) return { ...t, why: `:${port} is the ${s.pairTrade ? "pair trade" : "market maker"}, not the ${pair ? "pair trade" : "market maker"}` };
  const eq = s.paper.equity ?? null;
  return { ...t, up: true, equity: eq, pnl: eq != null && s.paper.start != null ? eq - s.paper.start : null, halted: s.paper.live?.halted ?? null };
}

/** The page's {{…}} placeholders filled in with this bot's asset (asset.ts), so one page serves any MM_ASSET. */
export function assetPage(html: string): string {
  const v: Record<string, string> = { ASSET: ASSET.name, ASSET_LONG: ASSET.long, BINANCE: ASSET.binance, COINBASE: ASSET.coinbase,
    CHAINLINK: ASSET.chainlink.toUpperCase(), APP: `${ASSET.key}5m` };
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => v[k] ?? m);
}

export function startServer(engine: Engine, log: (m: string) => void): http.Server {
  const page = path.join(ROOT, "public", "index.html");
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  // the PAPER | LIVE switch: the twin asked for its status every 5 s (null: no twin, or no answer yet)
  let twin: Twin | null = null;
  const askTwin = async (port: number) => {
    let st: unknown = null, err: string | null = null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) st = await r.json(); else err = `:${port} answered HTTP ${r.status}`;
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      err = code === "ECONNREFUSED" ? `nothing answers on :${port}: it is stopped`
        : (e as Error).name === "TimeoutError" ? `:${port} gave no answer in 2 s` : `:${port}: ${(e as Error).message}`;
    }
    twin = twinOf(CFG.mode === "live" ? "live" : "paper", port, CFG.pair.on, st, err, Date.now());
  };
  if (CFG.twinPort != null) {
    const port = CFG.twinPort;
    void askTwin(port);
    setInterval(() => void askTwin(port), 5000).unref();
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    try {
      // a page on another site can POST here from your browser; only this dashboard may
      const crossOrigin = () => { const o = req.headers.origin; return !!o && new URL(o).host !== req.headers.host; };
      if (req.method === "POST" && u.pathname === "/api/paper/reset") {
        if (crossOrigin()) return json(res, 403, { error: "cross-origin" });
        const body = await readBody(req, 4096);
        const start = Number((JSON.parse(body || "{}") as { start?: unknown }).start ?? CFG.paperStartUsdc);
        if (!Number.isFinite(start) || start < 1 || start > 10_000_000) return json(res, 400, { error: "start must be 1 to 10,000,000 USDC" });
        log(`[server] paper account reset requested (start $${start})`);
        const status = engine.paperReset(start);
        return status ? json(res, 200, { ok: true, status }) : json(res, 409, { error: `MM_MODE=${CFG.mode}: only a paper account can be reset (reset PnL instead)` });
      }
      if (req.method === "POST" && u.pathname === "/api/pnl/reset") {
        if (crossOrigin()) return json(res, 403, { error: "cross-origin" });
        log(`[server] PnL reset requested`);
        const status = engine.pnlReset();
        return status ? json(res, 200, { ok: true, status }) : json(res, 409, { error: `MM_MODE=${CFG.mode}: nothing is traded, there is no PnL` });
      }
      if (req.method === "POST" && u.pathname === "/api/live/sync") {
        if (crossOrigin()) return json(res, 403, { error: "cross-origin" });
        log(`[server] sync to wallet requested`);
        const r = await engine.walletSync();
        return r.ok ? json(res, 200, r) : json(res, 409, { error: r.error });
      }
      if (req.method === "POST" && u.pathname === "/api/live/profile") {
        if (crossOrigin()) return json(res, 403, { error: "cross-origin" });
        const body = await readBody(req, 1024);
        const name = String((JSON.parse(body || "{}") as { profile?: unknown }).profile ?? "");
        log(`[server] config switch to "${name}" requested`);
        const r = requestProfile(name, log);
        return r.ok ? json(res, 200, { ok: true, profile: profileStatus(true) }) : json(res, 409, { error: r.error });
      }
      if (req.method === "POST" && u.pathname === "/api/control") {
        if (crossOrigin()) return json(res, 403, { error: "cross-origin" });
        const body = JSON.parse((await readBody(req, 1024)) || "{}") as { size?: unknown; stopped?: unknown };
        log(`[server] control requested: ${JSON.stringify(body)}`);
        const r = engine.setControl(body);
        return r.ok ? json(res, 200, { ok: true, control: engine.control() }) : json(res, 409, { error: r.error });
      }
      if (req.method !== "GET") return json(res, 405, { error: "read-only" });
      if (u.pathname === "/api/control") return json(res, 200, engine.control());
      if (u.pathname === "/api/live/profile") {
        return CFG.mode === "live" ? json(res, 200, profileStatus(u.searchParams.get("fresh") === "1")) : json(res, 409, { error: `MM_MODE=${CFG.mode}: the switch is for the live bot` });
      }
      if (u.pathname === "/api/hour-regime") {
        const s = engine.hourRegimeStatus();
        return s ? json(res, 200, s) : json(res, 409, { error: "MM_HOUR_REGIME=off" });
      }
      if (u.pathname === "/api/live/wallet") {
        const g = await engine.walletGap();
        return g ? json(res, 200, g) : json(res, 409, { error: `MM_MODE=${CFG.mode}: no wallet` });
      }
      if (u.pathname === "/" || u.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(assetPage(fs.readFileSync(page, "utf8")));
      }
      if (u.pathname === "/api/status") return json(res, 200, engine.status());
      if (u.pathname === "/api/twin") return json(res, 200, twin);
      if (u.pathname === "/api/windows") return json(res, 200, engine.windowList(u.searchParams.get("date")));
      const m = u.pathname.match(/^\/api\/windows\/(\d+)$/);
      if (m) {
        const d = await engine.windowSeries(Number(m[1]));
        return d ? json(res, 200, d) : json(res, 404, { error: "no series for that window" });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  // socket servers on one port (the dashboard's and one a signal feed): each upgrade goes to the one its path names
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const feeds = Object.keys(FEEDS) as Feed[];
  const sigs = Object.fromEntries(feeds.map((f) => [f, new WebSocketServer({ noServer: true, perMessageDeflate: false })])) as Record<Feed, WebSocketServer>;
  const fillWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const byPath = new Map<string, WebSocketServer>([["/ws", wss], ...feeds.map((f) => [FEEDS[f].path, sigs[f]] as const), [FILL_FEED.path, fillWss]]);
  server.on("upgrade", (req, socket, head) => {
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    const to = byPath.get(p);
    if (!to) { socket.destroy(); return; }
    to.handleUpgrade(req, socket, head, (ws) => to.emit("connection", ws, req));
  });
  wss.on("connection", (ws) => {
    try { ws.send(JSON.stringify(engine.hello())); } catch { /* */ }
    ws.on("error", () => { /* */ });
  });
  engine.onFrame((msg) => {
    if (!wss.clients.size) return;
    const s = JSON.stringify(msg);
    for (const c of wss.clients) {
      // a slow client skips frames rather than buffering the server into the ground
      if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 2_000_000) c.send(s);
    }
  });

  for (const f of feeds) {
    const sig = sigs[f], tag = `[${FEEDS[f].path.slice(1)}]`;
    sig.on("connection", (ws, req) => {
      log(`${tag} subscriber ${req.socket.remoteAddress}:${req.socket.remotePort} connected (${sig.clients.size} now)`);
      try { ws.send(JSON.stringify(engine.signalHello(f))); } catch { /* */ }
      ws.on("error", () => { /* */ });
      ws.on("close", () => log(`${tag} subscriber ${req.socket.remoteAddress}:${req.socket.remotePort} left (${sig.clients.size} now)`));
    });
  }
  const toSig = (f: Feed, msg: unknown) => {
    const sig = sigs[f];
    if (!sig.clients.size) return;
    const s = JSON.stringify(msg);
    for (const c of sig.clients) if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1_000_000) c.send(s);
  };
  engine.onSignal(toSig);
  // WS /signal-fills: this bot's own maker fills of the kinds FILL_SIGNAL names (signal.ts "FILL SIGNAL")
  const toFills = (msg: unknown) => {
    if (!fillWss.clients.size) return;
    const s = JSON.stringify(msg);
    for (const c of fillWss.clients) if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1_000_000) c.send(s);
  };
  fillWss.on("connection", (ws, req) => {
    log(`[signal-fills] subscriber ${req.socket.remoteAddress}:${req.socket.remotePort} connected (${fillWss.clients.size} now)`);
    try { ws.send(JSON.stringify(engine.fillHello())); } catch { /* */ }
    ws.on("error", () => { /* */ });
    ws.on("close", () => log(`[signal-fills] subscriber ${req.socket.remoteAddress}:${req.socket.remotePort} left (${fillWss.clients.size} now)`));
  });
  engine.onFillSignal((m) => { toFills(m); log(`[signal-fills] #${m.seq} ${m.kind}: bought ${m.size} ${m.dir === "up" ? "Up" : "Down"} @ ${Math.round(m.price * 100)}¢ (order #${m.oid}), ${fillWss.clients.size} subscriber(s)`); });
  setInterval(() => toFills(engine.fillBeat()), CFG.signal.heartbeatMs).unref();
  setInterval(() => { for (const f of feeds) toSig(f, engine.signalBeat(f)); }, CFG.signal.heartbeatMs).unref();

  function readBody(req: http.IncomingMessage, max: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => { s += c; if (s.length > max) { reject(new Error("body too large")); req.destroy(); } });
      req.on("end", () => resolve(s));
      req.on("error", reject);
    });
  }

  server.listen(CFG.port, CFG.host, () => log(`[server] dashboard http://${CFG.host}:${CFG.port}  (push every ${CFG.uiPushMs} ms)`));
  return server;
}
