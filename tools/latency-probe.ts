// Venue latency probe (v2): can one signed order raced on several connections land sooner than a single post without
// being placed twice, and how fast does the venue's queue build after an ETH move starts? SENDS REAL ORDERS from the .env
// wallet, none meant to fill: BUYs of the market's minimum size at 1¢ on the current window's token bidding ≥ 10¢ (so ≥ 9¢
// under its ask), each cancelled by id once answered (never a cancel-all: another bot may share the wallet).
//   race    7 posts at once on warmed connections, in random order: a single order; 3 separately signed copies
//           ("distinct": 3 orders, the fastest is what racing them would get); one signed order posted 3 times
//           ("identical": the venue should keep one and refuse the others as duplicates). Every 10 s, and on half the
//           move triggers.
//   ladder  on the other half of the triggers: single orders 0, 100, 200 and 300 ms after the move is seen, to trace how
//           fast the queue builds.
// A trigger is a Binance mid move of 0.9 bp or more in 1 s (≥ 3 s apart; BTC's $8 at ~$90k, before the ETH port these
// were dollars); each record keeps the trigger's move and the largest 1 s move in the second after it, in bp (1.7+: the
// busy moments of the first probe, $15 on BTC). Per post: its send, the HTTP answer, every
// PLACEMENT event of its order id (venue clock, arrival here: an id placed twice shows up twice). Stays 10-280 s into a
// window. At the end, the market's open orders are checked for any of ours. v1 (2026-10-15 12:10-12:25, 92 bursts of 6
// distinct copies): README "Taker leg 1 again, and order timing".
// Usage: npx tsx tools/latency-probe.ts <out.jsonl> [MINUTES=15]   (Node >= 24; stop the live apps first)
import fs from "node:fs";
import { OrderSide, createSecureClient } from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";
import "../src/config.js";   // loads .env
import { ASSET } from "../src/asset.js";
import { walletSecrets } from "../src/trading/vault.js";   // the key: wallet vault, passphrase prompt
import { fetchMarket, WIN, type Market } from "../src/feeds/gamma.js";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: npx tsx tools/latency-probe.ts <out.jsonl> [MINUTES]");
const MINUTES = Number(process.argv[3] ?? 15);
const CLOB = "https://clob.polymarket.com";
const PRICE = 0.01, MIN_BID = 0.1, TIMER_MS = 10_000, TRIGGER_BPS = 0.9, TRIGGER_GAP_MS = 3000, LADDER_MS = [0, 100, 200, 300];

const T0 = Date.now();
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} +${String(Math.round((Date.now() - T0) / 1000)).padStart(5)}s ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => { const x = e as { name?: string; message?: string }; return `${x?.name ?? "Error"}: ${x?.message ?? String(e)}`.slice(0, 200); };
const epochMs = (x: unknown): number | null => { const v = Number(x); return Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : null; };
const shuffle = <T>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

if (parseInt(process.versions.node.split(".")[0], 10) < 24) throw new Error(`needs Node >= 24 (this is ${process.version})`);
const wsec = await walletSecrets(), pk = wsec.privateKey, wallet = process.env.POLYMARKET_FUNDER_ADDRESS ?? "";
if (!wallet) throw new Error("POLYMARKET_FUNDER_ADDRESS must be set in .env (the key comes from the wallet vault)");
const k = wsec.api?.key, s = wsec.api?.secret, p = wsec.api?.passphrase;
const base = { signer: privateKey(pk), wallet };
const client: any = k && s && p ? await createSecureClient({ ...base, credentials: { key: k, secret: s, passphrase: p } as never }) : await createSecureClient(base);

const coll = Number((await fetchBalanceAllowance(client, { assetType: "COLLATERAL" as never }) as any).balance) / 1e6;
log(`wallet ${wallet} · collateral $${coll.toFixed(2)} · ${MINUTES} min · race bursts (1 single + 3 distinct + 1 signed ×3) and ladders at ${PRICE * 100}¢ → ${OUT}`);
if (coll < 5) throw new Error("collateral under $5");

// ---- the user channel: every PLACEMENT of each order id (venue time, arrival), and any fill ----
const placed = new Map<string, { ts: number | null; rx: number }[]>();
const filled = new Map<string, number>();
const sub = await client.subscribe([{ topic: "user" }] as const);
void (async () => {
  try {
    for await (const ev of sub as AsyncIterable<any>) {
      const rx = Date.now();
      if (ev?.type !== "order") continue;
      const q = ev.payload, id = String(q.id);
      if (String(q.orderEventType) === "PLACEMENT") { const l = placed.get(id) ?? []; l.push({ ts: epochMs(q.timestamp), rx }); placed.set(id, l); }
      if (Number(q.sizeMatched) > 0) { filled.set(id, Number(q.sizeMatched)); log(`⚠ order …${id.slice(-8)} matched ${q.sizeMatched} at ${q.price}`); }
    }
  } catch (e) { log(`user channel ended: ${errText(e)}`); }
})();
await sleep(1500);

// ---- the window's token bidding the most (a 1¢ bid sits ≥ 9¢ under its ask) ----
let mk: Market | null = null, mkWin = 0, tok: { id: string; name: string; bid: number; at: number } | null = null;
const markets = new Set<string>();
const bestBid = async (tokenId: string): Promise<number> => {
  const b: any = await fetch(`${CLOB}/book?token_id=${tokenId}`).then((r) => r.json());
  return Math.max(0, ...(b.bids ?? []).map((x: any) => Number(x.price)).filter((x: number) => x > 0));
};
async function pickToken(): Promise<boolean> {
  const now = Date.now() / 1000, win = Math.floor(now / WIN) * WIN, into = now - win;
  if (into < 10 || into > WIN - 20) return false;
  if (mkWin !== win) { const m = await fetchMarket(win); if (!m) return false; mk = m; mkWin = win; tok = null; markets.add(m.conditionId); }
  if (!tok || Date.now() - tok.at > 30_000) {
    const [u, d] = await Promise.all([bestBid(mk!.upToken), bestBid(mk!.downToken)]);
    tok = u >= d ? { id: mk!.upToken, name: "Up", bid: u, at: Date.now() } : { id: mk!.downToken, name: "Down", bid: d, at: Date.now() };
  }
  return tok.bid >= MIN_BID;
}

// ---- Binance mid: triggers, and the largest 1 s move after each ----
const hist: [number, number][] = [];     // the last 10 s of mids, one every 20 ms at most
const move1s = (t: number): number | null => {
  let a: number | null = null, b: number | null = null;
  for (const [ts, m] of hist) { if (ts <= t - 1000) a = m; if (ts <= t) b = m; }
  return a != null && b != null ? ((b - a) / a) * 1e4 : null;   // bp
};
const peakAfter = (t: number): number => {
  let mx = 0;
  for (const [ts] of hist) if (ts >= t && ts <= t + 1000) { const m = move1s(ts); if (m != null && Math.abs(m) > Math.abs(mx)) mx = m; }
  return mx;
};

// ---- posts ----
interface Post { arm: "single" | "distinct" | "identical" | "ladder"; copy: number; offset: number; signed: unknown; sent?: number; ans?: number; r?: any }
const live = new Set<string>();     // accepted, cancel not yet confirmed
const ours = new Set<string>();     // every order id this run had accepted (the only ones it may cancel)
let nBurst = 0, busy = false, lastTrigger = 0, skipped = 0, stopping = false, ladderNext = true;

async function post(x: Post): Promise<void> {
  x.sent = Date.now();
  try { x.r = await client.postOrder(x.signed); } catch (e) { x.r = { ok: false, threw: errText(e) }; }
  x.ans = Date.now();
}
async function cancel(ids: string[]): Promise<Set<string>> {
  try {
    const r: any = await client.cancelOrders({ orderIds: ids });
    const ok = new Set<string>((r?.canceled ?? []).map(String));
    for (const i of ok) live.delete(i);
    return ok;
  } catch (e) { log(`cancel failed: ${errText(e)}`); return new Set(); }
}
const warm = (n: number) => Promise.all(Array.from({ length: n }, () => fetch(`${CLOB}/time`).then((r) => r.arrayBuffer(), () => null)));
const sign = (t: { id: string }, size: number) => client.createLimitOrder({ tokenId: t.id, price: PRICE, size, side: OrderSide.BUY, postOnly: true });

async function burst(kind: "race" | "ladder", trigger: "timer" | "move", trigAt: number, trigMove: number | null): Promise<void> {
  if (stopping) return;
  if (busy) { skipped++; return; }
  busy = true;
  try {
    if (!(await pickToken())) return;
    const id = ++nBurst, t = tok!, size = mk!.minSize;
    let posts: Post[];
    if (kind === "race") {
      const [a, b1, b2, b3, c] = await Promise.all([0, 1, 2, 3, 4].map(() => sign(t, size)));
      posts = shuffle<Post>([
        { arm: "single", copy: 0, offset: 0, signed: a },
        { arm: "distinct", copy: 0, offset: 0, signed: b1 }, { arm: "distinct", copy: 1, offset: 0, signed: b2 }, { arm: "distinct", copy: 2, offset: 0, signed: b3 },
        { arm: "identical", copy: 0, offset: 0, signed: c }, { arm: "identical", copy: 1, offset: 0, signed: c }, { arm: "identical", copy: 2, offset: 0, signed: c },
      ]);
      await warm(posts.length);     // one warm connection per post: a new one adds TCP + TLS (~20 ms)
      await Promise.all(posts.map(post));
    } else {
      const signed = await Promise.all(LADDER_MS.map(() => sign(t, size)));
      posts = LADDER_MS.map((off, i) => ({ arm: "ladder", copy: i, offset: off, signed: signed[i] }));
      await warm(2);
      const start = Date.now();
      await Promise.all(posts.map(async (x) => { const wait = start + x.offset - Date.now(); if (wait > 0) await sleep(wait); await post(x); }));
    }
    const ids = [...new Set(posts.filter((x) => x.r?.ok && x.r.orderId).map((x) => String(x.r.orderId)))];
    for (const i of ids) { live.add(i); ours.add(i); }
    const c0 = Date.now(), done = ids.length ? await cancel(ids) : new Set<string>(), c1 = Date.now();
    const wait = Math.max(300, trigAt + 1100 - Date.now());     // placement events trail by ~10 ms; the peak move needs 1 s
    await sleep(wait);
    const peak = trigger === "move" ? peakAfter(trigAt) : null;
    for (const x of posts) {
      const oid = x.r?.ok ? String(x.r.orderId) : null, pl = oid ? placed.get(oid) ?? [] : [];
      fs.appendFileSync(OUT, JSON.stringify({
        burst: id, kind, trigger, trigAt, trigMove, peakMove: peak, arm: x.arm, copy: x.copy, offset: x.offset, token: t.name, bid: t.bid, size,
        sent: x.sent, ans: x.ans, ok: !!x.r?.ok, status: x.r?.status ?? null,
        err: x.r?.ok ? null : (x.r?.threw ?? `${x.r?.code ?? ""} ${x.r?.message ?? ""}`.trim()),
        oid, placements: pl.length, placedTs: pl[0]?.ts ?? null, placedRx: pl[0]?.rx ?? null,
        cancelSent: c0, cancelAns: c1, cancelled: oid ? done.has(oid) : null, filled: oid ? filled.get(oid) ?? 0 : 0,
      }) + "\n");
    }
    const ms = (x: Post) => (x.ans! - x.sent!), by = (arm: string) => posts.filter((x) => x.arm === arm);
    const idn = by("identical"), idOk = idn.filter((x) => x.r?.ok).length, idPl = idn[0]?.r?.ok ? (placed.get(String(idn[0].r.orderId))?.length ?? 0) : null;
    log(kind === "race"
      ? `race ${id} ${trigger}${trigMove != null ? ` (${ASSET.name} ${trigMove >= 0 ? "+" : ""}${trigMove.toFixed(1)} bp, peak ${peak!.toFixed(1)})` : ""} · ${t.name} bid ${t.bid} · single ${by("single").map(ms)} · ` +
        `distinct ${by("distinct").map(ms).join("/")} · identical ${idn.map((x) => `${ms(x)}${x.r?.ok ? "" : "✗"}`).join("/")} ms (${idOk} accepted, ${idPl ?? "?"} placement(s)) · ` +
        `${done.size}/${ids.length} cancelled in ${c1 - c0} ms`
      : `ladder ${id} (${ASSET.name} ${trigMove! >= 0 ? "+" : ""}${trigMove!.toFixed(1)} bp, peak ${peak!.toFixed(1)}) · ${t.name} · ` +
        posts.map((x) => `+${x.sent! - trigAt}→${ms(x)}`).join(" · ") + ` ms · ${done.size}/${ids.length} cancelled`);
    const rejected = posts.filter((x) => !x.r?.ok && x.arm !== "identical");
    if (rejected.length) log(`  refused: ${rejected.map((x) => `${x.arm}: ${x.r?.threw ?? x.r?.message ?? x.r?.code}`).join(" | ")}`);
    const firstDup = idn.find((x) => !x.r?.ok);
    if (id <= 3 && firstDup) log(`  identical refusal reads: ${firstDup.r?.threw ?? JSON.stringify(firstDup.r).slice(0, 200)}`);
  } catch (e) { log(`burst failed: ${errText(e)}`); }
  finally { busy = false; }
}

// ---- triggers ----
const timer = setInterval(() => { void burst("race", "timer", Date.now(), null); }, TIMER_MS);
let ws: WebSocket | null = null;
const connect = () => {
  ws = new WebSocket(`wss://stream.binance.com:9443/ws/${ASSET.binance.toLowerCase()}@bookTicker`);
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data)), mid = (Number(d.b) + Number(d.a)) / 2, now = Date.now();
    if (!Number.isFinite(mid)) return;
    const last = hist[hist.length - 1];
    if (last && now - last[0] < 20) last[1] = mid; else hist.push([now, mid]);
    while (hist.length && hist[0][0] < now - 10_000) hist.shift();
    const mv = move1s(now);
    if (mv == null || Math.abs(mv) < TRIGGER_BPS || now - lastTrigger < TRIGGER_GAP_MS || busy || stopping) return;
    lastTrigger = now;
    void burst(ladderNext ? "ladder" : "race", "move", now, mv);
    ladderNext = !ladderNext;
  };
  ws.onclose = () => { if (!stopping) setTimeout(connect, 1000); };
};
connect();

async function finish(why: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  try { ws?.close(); } catch { /* */ }
  log(`stopping (${why}) · waiting for the burst in flight`);
  while (busy) await sleep(50);
  for (let i = 0; i < 5 && live.size; i++) { log(`cancelling ${live.size} order(s) not confirmed cancelled`); await cancel([...live]); if (live.size) await sleep(1000); }
  // any of ours still open on the markets touched (a duplicate placed twice would show here)
  for (const market of markets) {
    try {
      const mine: string[] = [];
      let others = 0;
      for await (const page of client.listOpenOrders({ market }) as AsyncIterable<{ items: any[] }>)
        for (const o of page.items) { if (ours.has(String(o.id))) mine.push(String(o.id)); else others++; }
      if (mine.length) { log(`⚠ ${mine.length} of this run's orders still open on …${market.slice(-8)}: cancelling`); await cancel(mine); }
      else log(`none of this run's orders open on …${market.slice(-8)}${others ? ` (${others} other order(s) of the account, left alone)` : ""}`);
    } catch (e) { log(`open orders of …${market.slice(-8)}: ${errText(e)}`); }
  }
  if (live.size) log(`⚠ ${live.size} order(s) may still rest: ${[...live].join(", ")} — cancel them on polymarket.com`);
  log(`done: ${nBurst} bursts (${skipped} triggers skipped while one was in flight), fills seen: ${filled.size}`);
  try { await sub.close(); } catch { /* */ }
  process.exit(0);
}
process.on("SIGINT", () => { void finish("SIGINT"); });
process.on("SIGTERM", () => { void finish("SIGTERM"); });
setTimeout(() => { void finish(`${MINUTES} min up`); }, MINUTES * 60_000);
