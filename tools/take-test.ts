// Real taker-order test: what the pair trade's live legs need to know before they go out. SENDS REAL ORDERS from the .env
// wallet: one fill-and-kill BUY of SIZE shares of the current ETH-5m window's token nearer 50¢ at its ask + 1¢, then the
// same of the other token at its ask + 2¢ (a pair, about $5 for 5 shares), then a merge of the pair back into collateral
// (needs the Relayer API key). Prints, raw, what the venue says at each step:
//   post      the HTTP answer (status matched / delayed, making / taking amounts) and its round trip
//   channel   every user-channel event of the run (order: cumulative size_matched; trade: the maker orders and prices)
//   trades    the account's trades of the market: taker side, maker prices, fee rate
//   wallet    collateral and both tokens before and after each leg: the shares received and the USDC paid, so how the
//             taker fee is charged (in shares or in USDC) shows directly
// Stays 20-200 s into a window, on a token asking 25-75¢. Usage: npx tsx tools/take-test.ts [SIZE]   (Node >= 24)
import { OrderSide, createSecureClient, relayerApiKey } from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";
import "../src/config.js";   // loads .env
import { walletSecrets } from "../src/trading/vault.js";   // the key: wallet vault, passphrase prompt
import { fetchMarket, WIN } from "../src/feeds/gamma.js";

const SIZE = Number(process.argv[2] ?? 5);
const t0 = Date.now();
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} +${String(Date.now() - t0).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// the user channel's owner fields are the API key: not printed
const clean = (x: unknown) => JSON.stringify(x, (k, v) => (/^(owner|tradeOwner|trade_owner)$/.test(k) ? "…" : typeof v === "bigint" ? v.toString() : v));

if (parseInt(process.versions.node.split(".")[0], 10) < 24) throw new Error(`needs Node >= 24 (this is ${process.version})`);
const wsec = await walletSecrets(), pk = wsec.privateKey, wallet = process.env.POLYMARKET_FUNDER_ADDRESS ?? "";
if (!wallet) throw new Error("POLYMARKET_FUNDER_ADDRESS must be set in .env (the key comes from the wallet vault)");
const k = wsec.api?.key, s = wsec.api?.secret, p = wsec.api?.passphrase;
const rk = wsec.relayerKey, ra = process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS;
const base = { signer: privateKey(pk), wallet, ...(rk && ra ? { apiKey: relayerApiKey({ key: rk, address: ra }) } : {}) };
const client: any = k && s && p
  ? await createSecureClient({ ...base, credentials: { key: k, secret: s, passphrase: p } as never })
  : await createSecureClient(base);

const coll = async () => Number((await fetchBalanceAllowance(client, { assetType: "COLLATERAL" as never }) as any).balance) / 1e6;
const tok = async (tokenId: string) => Number((await fetchBalanceAllowance(client, { assetType: "CONDITIONAL" as never, tokenId }) as any).balance) / 1e6;
const bestAsk = async (tokenId: string): Promise<number | null> => {
  const b: any = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`).then((r) => r.json());
  const a = (b.asks ?? []).map((x: any) => Number(x.price)).filter((x: number) => x > 0);
  return a.length ? Math.min(...a) : null;
};

const bal0 = await coll();
log(`wallet ${wallet} · collateral $${bal0.toFixed(2)} · ${SIZE} shares a leg · relayer ${rk && ra ? "yes" : "NO (no merge)"}`);
if (bal0 < 20) throw new Error("collateral under $20");

// ---- the user channel, every event logged ----
const events: { rx: number; ev: unknown }[] = [];
const sub = await client.subscribe([{ topic: "user" }] as const);
void (async () => { try { for await (const ev of sub as AsyncIterable<any>) { events.push({ rx: Date.now(), ev }); log(`channel ${ev?.type}: ${clean(ev?.payload ?? ev)}`); } } catch (e) { log(`channel ended: ${(e as Error).message}`); } })();
await sleep(1500);

// ---- a window 20-200 s in ----
let mk: Awaited<ReturnType<typeof fetchMarket>> = null;
for (;;) {
  const now = Date.now() / 1000, win = Math.floor(now / WIN) * WIN, into = now - win;
  if (into >= 20 && into <= 200) { mk = await fetchMarket(win); if (mk) break; }
  await sleep(1000);
}
const m = mk!;
log(`window ${m.slug} · up …${m.upToken.slice(-8)} · down …${m.downToken.slice(-8)} · condition …${m.conditionId.slice(-8)} · min size ${m.minSize}`);

async function leg(name: string, tokenId: string, slip: number): Promise<{ orderId: string | null }> {
  const ask = await bestAsk(tokenId);
  if (ask == null || ask < 0.25 || ask > 0.75) { log(`${name}: ask ${ask} outside 25-75¢, not sent`); return { orderId: null }; }
  const price = Math.round((ask + slip) * 100) / 100;
  const [c0, t0b] = await Promise.all([coll(), tok(tokenId)]);
  const ts = Date.now();
  const signed: any = await client.createLimitOrder({ tokenId, price, size: SIZE, side: OrderSide.BUY });
  signed.orderType = "FAK";
  const tSign = Date.now();
  let r: any;
  try { r = await client.postOrder(signed); } catch (e) { r = { threw: `${(e as Error).name}: ${(e as Error).message}` }; }
  const tPost = Date.now();
  log(`${name}: BUY ${SIZE} ≤ ${price} (ask ${ask}) · makerAmount ${signed.makerAmount} takerAmount ${signed.takerAmount} · sign ${tSign - ts} ms · post ${tPost - tSign} ms → ${clean(r)}`);
  await sleep(4000);
  const [c1, t1] = await Promise.all([coll(), tok(tokenId)]);
  log(`${name}: wallet: collateral ${c0.toFixed(6)} → ${c1.toFixed(6)} (paid ${(c0 - c1).toFixed(6)}) · token ${t0b.toFixed(6)} → ${t1.toFixed(6)} (got ${(t1 - t0b).toFixed(6)})`);
  return { orderId: r?.orderId ?? null };
}

const nearer = Math.abs(((await bestAsk(m.upToken)) ?? 1) - 0.5) <= Math.abs(((await bestAsk(m.downToken)) ?? 1) - 0.5);
const [first, second] = nearer ? [m.upToken, m.downToken] : [m.downToken, m.upToken];
const l1 = await leg(`leg 1 (${nearer ? "Up" : "Down"})`, first, 0.01);
const l2 = l1.orderId ? await leg(`leg 2 (${nearer ? "Down" : "Up"})`, second, 0.02) : { orderId: null };

// ---- the venue's records of the two orders ----
for (const id of [l1.orderId, l2.orderId]) {
  if (!id) continue;
  try { log(`order …${id.slice(-8)} record: ${clean(await client.fetchOrder({ orderId: id }))}`); }
  catch (e) { log(`order …${id.slice(-8)} record: ${(e as Error).name} ${(e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message}`); }
}
await sleep(3000);
for await (const page of client.listAccountTrades({ market: m.conditionId }) as AsyncIterable<{ items: any[] }>) {
  for (const t of page.items) if ([l1.orderId, l2.orderId].includes(String(t.takerOrderId))) log(`trade: ${clean(t)}`);
}

// ---- merge what pairs ----
const [u, d] = await Promise.all([tok(m.upToken), tok(m.downToken)]);
const pairs = Math.floor(Math.min(u, d) * 1e6) / 1e6;
log(`wallet holds ${u} Up / ${d} Down of the window → ${pairs} pairs`);
if (pairs > 0 && rk && ra) {
  try {
    const h: any = await client.mergePositions({ amount: BigInt(Math.round(pairs * 1e6)), conditionId: m.conditionId });
    const out = await h.wait();
    log(`merged ${pairs} pairs: ${out.transactionHash}`);
  } catch (e) { log(`merge failed: ${(e as Error).name}: ${(e as Error).message}`); }
}
const [c9, u9, d9] = await Promise.all([coll(), tok(m.upToken), tok(m.downToken)]);
log(`end: collateral $${c9.toFixed(6)} (${(c9 - bal0 >= 0 ? "+" : "")}${(c9 - bal0).toFixed(6)}) · ${u9} Up / ${d9} Down left`);
try { await sub.close(); } catch { /* */ }
process.exit(0);
