// Real-order latency test: the measurement behind PAPER_LATENCY_MS and the sweep model's PAPER_SWEEP_PLACE_MS /
// PAPER_SWEEP_CANCEL_MS. Re-run it after moving the bot to another server. SENDS REAL ORDERS from the wallet (key in the wallet vault):
// N post-only BUY bids of 5.37 shares at 1¢ on the current ETH-5m window's favourite token, one at a time, each cancelled
// 0.7 s after it was sent (about $0.05 each; nobody sells the favourite at 1¢: none of the 31 sent on 2026-10-13 filled).
// Stays out of the first 8 s and the last 30 s of a window. Cancels name their orders only: the wallet may be shared.
//   place / cancel seen   send → the 1¢ bid level moving by exactly ±5.37 on the public market feed (local receive time)
//   at venue              send → that feed message's exchange timestamp (needs a synced clock: chronyc tracking)
//   feed lag              local receive − exchange timestamp of the feed, in this light process; the running bot sees
//                         a few ms more (/api/status feeds.pm.lagP50), which is the one PAPER_SWEEP_FEEDLAG_MS wants
//   sign / ack            the SDK's order signing (cached after the first), and send → the HTTP answer
// Usage: npm run live:latency [-- N]   (Node >= 24, like the live bot: export PATH=~/.nvm/versions/node/v24.*/bin:$PATH)
// 2026-10-13, AWS eu-west-1, 30 orders: place seen 36 ms median (p90 79), cancel 29 (p90 79), at venue 28 / 21,
// feed lag 8. Helsinki, 2026-10-12: place 68 (p90 89), cancel 56 (p90 69), feed lag ~18.
import { OrderSide, createSecureClient } from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";
import "../src/config.js";   // loads .env
import { walletSecrets } from "../src/trading/vault.js";   // the key: wallet vault, passphrase prompt
import { fetchMarket, WIN } from "../src/feeds/gamma.js";

const N = Number(process.argv[2] ?? 30), SIZE = 5.37, PRICE = 0.01, CANCEL_AFTER = 700, GAP = 2500, TIMEOUT = 3000;
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at1c = (p: unknown) => Math.round(Number(p) * 10_000) === Math.round(PRICE * 10_000);

if (parseInt(process.versions.node.split(".")[0], 10) < 24) throw new Error(`needs Node >= 24 (this is ${process.version})`);
const wsec = await walletSecrets(), pk = wsec.privateKey, wallet = process.env.POLYMARKET_FUNDER_ADDRESS ?? "";
if (!wallet) throw new Error("POLYMARKET_FUNDER_ADDRESS must be set in .env (the key comes from the wallet vault)");
// built as venue.ts builds it, but signing and sending are timed apart
const k = wsec.api?.key, s = wsec.api?.secret, p = wsec.api?.passphrase;
const base = { signer: privateKey(pk), wallet };
const client: any = k && s && p
  ? await createSecureClient({ ...base, credentials: { key: k, secret: s, passphrase: p } as never })
  : await createSecureClient(base);
const bal = Number((await fetchBalanceAllowance(client, { assetType: "COLLATERAL" as never }) as any).balance) / 1e6;
log(`wallet ${wallet} · collateral $${bal.toFixed(2)} · ${N} orders`);
if (bal < 1) throw new Error("collateral under $1");

// ---- the public market feed: the 1¢ bid level of the window's tokens ----
interface Seen { rx: number; ts: number }
const level = new Map<string, number>();
const waiters: { token: string; delta: number; done: (s: Seen) => void }[] = [];
const feedLag: number[] = [];
let ws: WebSocket | null = null;

function onLevel(token: string, size: number, rx: number, ts: number): void {
  const d = size - (level.get(token) ?? 0);
  level.set(token, size);
  const i = waiters.findIndex((w) => w.token === token && Math.abs(d - w.delta) < 1e-6);
  if (i >= 0) waiters.splice(i, 1)[0].done({ rx, ts });
}

/** Subscribes to the tokens; resolves once both books' snapshots are in. */
function connectFeed(tokens: string[]): Promise<void> {
  const old = ws;
  ws = null;
  try { old?.close(); } catch { /* */ }
  level.clear();
  return new Promise((resolve) => {
    const w = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    ws = w;
    let books = 0;
    w.onopen = () => w.send(JSON.stringify({ assets_ids: tokens, type: "market" }));
    w.onmessage = (e) => {
      const rx = Date.now();
      if (e.data === "PONG") return;
      let msg: any;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      for (const ev of Array.isArray(msg) ? msg : [msg]) {
        const ts = Number(ev?.timestamp);
        if (ts > 0) feedLag.push(rx - ts);
        if (ev?.event_type === "book" && tokens.includes(String(ev.asset_id))) {
          const l = (ev.bids ?? []).find((x: any) => at1c(x.price));
          level.set(String(ev.asset_id), l ? Number(l.size) : 0);
          if (++books === tokens.length) resolve();
        } else if (ev?.event_type === "price_change") {
          for (const ch of ev.price_changes ?? []) {
            if (String(ch.side).toUpperCase() === "BUY" && at1c(ch.price) && tokens.includes(String(ch.asset_id)))
              onLevel(String(ch.asset_id), Number(ch.size), rx, ts);
          }
        }
      }
    };
    w.onclose = () => { if (ws === w) setTimeout(() => void connectFeed(tokens), 500); };
  });
}
setInterval(() => { try { ws?.send("PING"); } catch { /* */ } }, 10_000).unref();

/** The 1¢ level of `token` moving by exactly `delta`; null after TIMEOUT. */
function waitFor(token: string, delta: number): Promise<Seen | null> {
  return new Promise((res) => {
    const w = { token, delta, done: (x: Seen) => res(x) };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(null); } }, TIMEOUT);
  });
}

// ---- the orders ----
const open = new Set<string>(), markets = new Set<string>(), rows: Record<string, any>[] = [];
async function cleanup(): Promise<void> {
  if (!open.size) return;
  const r: any = await client.cancelOrders({ orderIds: [...open] }).catch((e: Error) => ({ error: e.message }));
  log(`cleanup: cancel ${[...open].join(", ")} → ${JSON.stringify(r).slice(0, 300)}`);
  for (const id of (r?.canceled ?? []).map(String)) open.delete(id);
}
process.on("SIGINT", () => { void cleanup().finally(() => process.exit(130)); });

let curWin = 0, tokens: [string, string] | null = null;
try {
  for (let n = 1; n <= N;) {
    const now = Date.now(), win = Math.floor(now / 1000 / WIN) * WIN, into = now / 1000 - win;
    if (into < 8 || into > WIN - 30) { await sleep(1000); continue; }
    if (win !== curWin) {
      const mk = await fetchMarket(win);
      if (!mk) { await sleep(2000); continue; }
      curWin = win; tokens = [mk.upToken, mk.downToken]; markets.add(mk.conditionId);
      await connectFeed(tokens);
      log(`window ${mk.slug}`);
    }
    // bid the favourite: the token nobody would sell at 1¢
    const mid = Number((await fetch(`https://clob.polymarket.com/midpoint?token_id=${tokens![0]}`).then((r) => r.json()).catch(() => ({})) as any).mid);
    if (!Number.isFinite(mid)) { await sleep(1000); continue; }
    const token = mid >= 0.5 ? tokens![0] : tokens![1];
    const r: Record<string, any> = { n, fav: +Math.max(mid, 1 - mid).toFixed(3) };

    const tCall = Date.now();
    const signed = await client.createLimitOrder({ tokenId: token, price: PRICE, size: SIZE, side: OrderSide.BUY, postOnly: true });
    const placeSeen = waitFor(token, +SIZE);
    const tSend = Date.now();
    r.signMs = tSend - tCall;
    let res: any;
    try { res = await client.postOrder(signed); } catch (e) { res = { ok: false, message: (e as Error).message }; }
    r.postAckMs = Date.now() - tSend;
    if (!res?.ok) {
      log(`#${n} post refused: ${JSON.stringify(res).slice(0, 200)}`);
      rows.push({ ...r, refused: true }); n++; await sleep(GAP); continue;
    }
    r.id = String(res.orderId); open.add(r.id);

    await sleep(Math.max(0, tSend + CANCEL_AFTER - Date.now()));
    const cancelSeen = waitFor(token, -SIZE);
    const tCancel = Date.now();
    let cr: any;
    try { cr = await client.cancelOrder({ orderId: r.id }); } catch (e) { cr = { error: (e as Error).message }; }
    r.cancelAckMs = Date.now() - tCancel;
    if ((cr?.canceled ?? []).map(String).includes(r.id)) open.delete(r.id);
    else log(`#${n} cancel not confirmed: ${JSON.stringify(cr).slice(0, 200)}`);

    const pl = await placeSeen, ca = await cancelSeen;
    if (pl) Object.assign(r, { placeSeenMs: pl.rx - tSend, placeVenueMs: pl.ts - tSend, placeFeedLagMs: pl.rx - pl.ts });
    if (ca) Object.assign(r, { cancelSeenMs: ca.rx - tCancel, cancelVenueMs: ca.ts - tCancel, cancelFeedLagMs: ca.rx - ca.ts });
    rows.push(r);
    log(`#${n} fav ${r.fav} · sign ${r.signMs} · place seen ${r.placeSeenMs ?? "—"} ms (venue ${r.placeVenueMs ?? "—"}, ack ${r.postAckMs})`
      + ` · cancel seen ${r.cancelSeenMs ?? "—"} ms (venue ${r.cancelVenueMs ?? "—"}, ack ${r.cancelAckMs})`);
    n++;
    await sleep(GAP);
  }
} finally {
  await cleanup();
}

// ---- fills (expected none) and the summary ----
const ids = new Set(rows.map((r) => r.id).filter(Boolean));
let filled = 0;
for (const market of markets) {
  for await (const page of client.listAccountTrades({ market }) as AsyncIterable<{ items: any[] }>) {
    for (const t of page.items) for (const m of t.makerOrders ?? []) if (ids.has(String(m.orderId))) filled += Number(m.matchedAmount);
  }
}
const q = (a: number[], x: number) => { const v = [...a].sort((u, w) => u - w); return v.length ? v[Math.min(v.length - 1, Math.floor(x * v.length))] : NaN; };
const col = (key: string) => rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
console.log("");
for (const key of ["signMs", "postAckMs", "placeSeenMs", "placeVenueMs", "placeFeedLagMs", "cancelAckMs", "cancelSeenMs", "cancelVenueMs", "cancelFeedLagMs"]) {
  const a = col(key);
  console.log(`${key.padEnd(16)} p10 ${q(a, 0.1)}  p50 ${q(a, 0.5)}  p90 ${q(a, 0.9)}  max ${a.length ? Math.max(...a) : NaN}  (n=${a.length})`);
}
console.log(`feed lag, all messages: p50 ${q(feedLag, 0.5)} p90 ${q(feedLag, 0.9)} (n=${feedLag.length})`);
console.log(`refused ${rows.filter((r) => r.refused).length} · still open ${open.size} · shares filled ${filled}`);
const pSeen = q(col("placeSeenMs"), 0.5), cSeen = q(col("cancelSeenMs"), 0.5), cVen = q(col("cancelVenueMs"), 0.5);
console.log(`→ PAPER_LATENCY_MS ≈ ${Math.ceil((pSeen + cSeen) / 2 / 5) * 5} · PAPER_SWEEP_PLACE_MS ≈ ${q(col("placeVenueMs"), 0.5)}`
  + ` · PAPER_SWEEP_CANCEL_MS ≈ ${cVen} + 32 margin = ${cVen + 32} · PAPER_SWEEP_FEEDLAG_MS: read the running bot's feeds.pm.lagP50`);
process.exit(open.size ? 1 : 0);
