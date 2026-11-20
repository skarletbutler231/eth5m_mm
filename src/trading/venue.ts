// VENUE — the real Polymarket CLOB for MM_MODE=live, through @polymarket/client 0.6. Everything that holds the key or
// talks to the venue is in this file; the live exchange only sees the Venue interface (the self-test drives a fake one).
//
// Why this SDK: the account is a Polymarket Deposit Wallet (POLYMARKET_SIGNATURE_TYPE=3), a contract that proves
// ownership through ERC-1271. The old @polymarket/clob-client can't sign for it and its order version is refused
// (polymarket_LastEntry's clobSigner.ts, 2026-08-17). The new client works out the wallet type from the address.
//
// Orders     post-only GTC BUYs: the venue refuses one that would cross (code post_only_would_cross), so the bot never
//            pays the taker fee by accident.
// Copies     LIVE_POST_COPIES > 1: an order (bid or take) is signed once and that one body posted that many times at once,
//            on as many warm connections (racePosts). The venue queues each post; the first to clear the queue is placed
//            and the others are refused as "Duplicated", so the order lands when its fastest copy does. Separately signed
//            copies would be separate orders, each able to fill; one body is one order, and its signed amount caps what
//            every copy can spend together.
// Cancels    by order id, through the SDK's cancelOrder; LIVE_CANCEL_HTTP=own sends the same DELETE /order on the bot's own
//            request (ownCanceller: synchronous HMAC, global fetch), falling back to the SDK on anything but HTTP 200;
//            LIVE_CANCEL_COPIES > 1 sends each cancel that many times at once and counts it done at the first copy that
//            cancelled (raceCancels). Both default off; neither was tried against the venue before 2026-11-11.
// Takes      the pair trade's legs: fill-and-kill market BUYs of a USDC amount up to a max price. A real 5-share pair
//            (tools/take-test.ts, 2026-10-14) showed: the post answers "matched" with the making (USDC) and taking
//            (shares) amounts after ~210 ms, the 150 ms taker hold included; a better price buys more shares (the whole
//            amount is spent: 5 Up ≤ 26¢ got 5.2 at 25¢); the fee, 0.07·p(1−p) a share at the fill price, comes out of
//            the collateral on top; the user channel sends `trade` events (MATCHED, MINED, CONFIRMED), no `order` events.
// Order id   the venue's order id is the order's hash (orderHash.ts), known once the order is signed: postBid hands it to
//            `onSigned` before the post goes out, so LIVE_EARLY_CANCEL can cancel an order whose post is still unanswered.
//            Real 1¢ orders (2026-10-29, latency/tools/orders.ts idcancel, 64 orders calm and on BTC-move bursts): the id
//            matched in 16 of 16 accepted orders; a cancel that reached the venue before its post was answered "order can't
//            be found - already canceled or matched" and the post was then refused "… is invalid. Already canceled." (48 of
//            48 such orders, posts up to 785 ms slow); one that came after the placement cancelled it.
// User feed  the `user` channel: `order` events (PLACEMENT / UPDATE / CANCELLATION) with the order's cumulative
//            size_matched. It reconnects with a backoff; while it is down the trader sends no new orders. Each event keeps
//            the venue's timestamp and its arrival here, and each post its signing time, for the live exchange's timing line.
// Records   GET /data/order/<id> answers null once an order is off the book (filled or cancelled; the SDK throws on
//            it, 2026-10-13), so a gone order's fills are summed from the account's trades of its market instead.
// Key        the private key, the optional L2 creds and the Relayer API key come from the encrypted wallet vault
//            (vault.ts: wallet.vault, unlocked by a passphrase typed at startup and held in memory only), never from .env.
// Chain      merge (Up+Down pairs → $1) and redeem (the winning side after resolution) go through the SDK's gasless
//            wallet transactions, which need a Relayer API key (vault + POLYMARKET_RELAYER_API_KEY_ADDRESS); without one
//            the bot leaves them to polymarket.com (2026-10-13: "Gasless transactions require a Relayer API Key").
// Sharing    the wallet may be traded by another bot too (pmqb's PMQB-BTC5-platform has the same funder, 2026-10-13), so
//            nothing here touches the account as a whole: cancels name their orders and merges their amount. A redeem
//            is per market and collects whatever the wallet holds of it, the other bot's winnings included.
import crypto from "node:crypto";
import { OrderSide, OrderType, createSecureClient, relayerApiKey } from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { privateKey } from "@polymarket/client/viem";
import { orderId } from "./orderHash.js";
import { walletSecrets } from "./vault.js";

/** making / taking: a take's USDC spent and shares bought, when the answer has them (status "matched"). signMs: how long
 *  signing took here before the request went out (the rest of the round trip is the network and the venue). */
export type PostResult = ({ ok: true; orderId: string; status: string; making?: number; taking?: number } | { ok: false; code: string; message: string }) & { signMs?: number; race?: RaceInfo };

/** One signed order posted `n` times at once: each copy's answer as it came (epoch ms), "ok", "dup" (the venue's
 *  duplicate refusal: another copy was there first), "timeout" (the venue's "order timed out") or the refusal's code.
 *  Copies still in flight when the race is decided are added as they answer. */
export interface RaceInfo { n: number; got: { what: string; at: number }[] }

/** Posts one signed order n times at once (each post() sends that same body). The venue places it once: latency probe v2
 *  (2026-10-15) posted 769 bodies 3 times each, and every one was accepted once and placed once, the other copies refused
 *  "order … is invalid. Duplicated."; the check runs after the queue, so the order lands with its fastest copy. Resolves
 *  with the first copy accepted. With none: once every copy has answered, the first real refusal (the order does not
 *  exist: e.g. a FAK with nothing to match, a post-only that would cross), else "uncertain" (only duplicates, timeouts
 *  or lost answers: a copy may have been placed with its answer lost, so the live exchange watches the user channel). */
export function racePosts(n: number, post: () => Promise<PostResult>, warn: (m: string) => void = () => {}): Promise<PostResult> {
  const info: RaceInfo = { n, got: [] }, all: PostResult[] = [];
  const kind = (r: PostResult) => (r.ok ? "ok" : /duplicated/i.test(r.message) ? "dup" : /timed out/i.test(r.message) ? "timeout" : r.code);
  return new Promise((resolve) => {
    let won: string | null = null, left = n;
    for (let i = 0; i < n; i++) {
      post().catch((e): PostResult => ({ ok: false, code: "uncertain", message: errText(e) })).then((r) => {
        const what = kind(r);
        info.got.push({ what, at: Date.now() });
        all.push(r);
        if (r.ok) {
          if (won == null) { won = r.orderId; resolve({ ...r, race: info }); }
          else warn(`[live] ⚠ order …${r.orderId.slice(-8)} accepted by more than one of its ${n} copies (first …${won.slice(-8)}): its fills are booked from its trades`);
        }
        if (--left > 0 || won != null) return;
        const refusal = all.find((x) => !x.ok && x.code !== "uncertain" && !/^(dup|timeout)$/.test(kind(x)));
        resolve(refusal ? { ...refusal, race: info }
          : { ok: false, code: "uncertain", message: `none of ${n} copies accepted (${info.got.map((g) => g.what).join(", ")})`, race: info });
      });
    }
  });
}
export interface VenueOrderUpdate {
  orderId: string; type: string; sizeMatched: number; status: string | null;
  /** The order itself (absent on a reconcile): lets a post whose answer was lost be recognised. */
  tokenId?: string; price?: number; size?: number;
  /** The event's time on the venue's clock and when it reached this process (epoch ms; absent on a reconcile). */
  ts?: number; rx?: number;
}

/** A trade of ours from the user channel (each status of it: MATCHED, MINED, CONFIRMED, FAILED). For a taker, its shares and
 *  their cost from the maker orders it matched: a maker of the other token (pair-minting) sold at 1 − its price.
 *  ts / rx: the event's time on the venue's clock and when it reached this process (epoch ms). */
export interface VenueTrade { tradeId: string; takerOrderId: string; taker: boolean; tokenId: string; status: string; size: number; cost: number; ts?: number; rx?: number }

export interface Venue {
  /** The wallet the fills settle into. */
  readonly wallet: string;
  /** The user channel is up (fills are visible). */
  connected(): boolean;
  /** When the user channel was last down (ms; 0 = never since the start): fills of that time may not have arrived. */
  lastDown(): number;
  /** onSigned: the order's venue id (its hash), called once it is signed and before it is sent; not called when the id
   *  can't be read from the signature (only a Deposit Wallet's signature carries the order's hashes). */
  postBid(tokenId: string, price: number, size: number, onSigned?: (orderId: string) => void): Promise<PostResult>;
  /** A fill-and-kill market BUY spending up to `usd` at prices up to `maxPrice`; the answer carries what it matched. */
  postTake(tokenId: string, usd: number, maxPrice: number): Promise<PostResult>;
  /** Sign (never send) a throwaway order of each token, so its market (tick, fees, neg risk) is cached before an order
   *  needs it: a token's first order waited ~1 s for it (2026-10-14 16:10: 1158 ms, the next 303 ms). */
  warm(tokenIds: string[]): Promise<void>;
  /** ok = the venue cancelled it; otherwise its reason (already matched, not found, ...). Throws on a network error. */
  cancel(orderId: string): Promise<{ ok: boolean; reason: string }>;
  /** These orders; how many went. (Never every order of the account: other bots may share the wallet.) */
  cancelMany(orderIds: string[]): Promise<number>;
  /** The order's record while it rests; "gone" once it is off the book (filled or cancelled); null = the read failed. */
  fetchOrder(orderId: string): Promise<{ sizeMatched: number; status: string } | "gone" | null>;
  /** Shares matched per order id of ours, from the account's trades of the market (failed trades left out). */
  matched(market: string, orderIds: string[]): Promise<Map<string, number>>;
  /** A Relayer API key is configured: merges and redeems can be sent. */
  readonly gasless: boolean;
  /** Collateral (pUSD) in the wallet, USDC. */
  balance(): Promise<number>;
  /** Shares of one outcome token in the wallet. */
  tokenBalance(tokenId: string): Promise<number>;
  /** Merge this many Up+Down pairs of the market into collateral; the transaction hash. */
  merge(conditionId: string, pairs: number): Promise<string | null>;
  /** Redeem the resolved market's tokens; the transaction hash. */
  redeem(conditionId: string): Promise<string | null>;
  onOrder(cb: (u: VenueOrderUpdate) => void): void;
  onTrade(cb: (t: VenueTrade) => void): void;
  close(): Promise<void>;
}

/** A user-channel trade payload, as VenueTrade. */
export function venueTrade(q: any): VenueTrade {
  const tokenId = String(q?.tokenId ?? "");
  let size = 0, cost = 0;
  for (const m of q?.makerOrders ?? []) {
    const a = Number(m.matchedAmount), p = Number(m.price);
    if (a > 0 && p > 0) { size += a; cost += a * (String(m.tokenId) === tokenId ? p : 1 - p); }
  }
  if (!(size > 0)) { size = Number(q?.size) || 0; cost = size * (Number(q?.price) || 0); }
  return { tradeId: String(q?.id ?? ""), takerOrderId: String(q?.takerOrderId ?? ""), taker: q?.traderSide === "TAKER", tokenId,
    status: String(q?.status ?? "").toUpperCase().replace(/^TRADE_STATUS_/, ""), size, cost, ts: epochMs(q?.timestamp) };
}

/** The venue's event time (epoch ms), if it sent one. The SDK passes its number through as is, and the venue's docs show
 *  whole seconds in places: a value under 1e12 is taken as seconds. */
const epochMs = (x: unknown): number | undefined => { const v = Number(x); return Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : undefined; };

/** A post that threw: the venue's refusal (the order does not exist) or "uncertain" (it may). */
export function postFailure(name: string, message: string): PostResult {
  if (/^(RequestRejectedError|RateLimitError|UserInputError|SigningError)$/.test(name))
    return { ok: false, code: /crosses book/i.test(message) ? "post_only_would_cross" : name === "RateLimitError" ? "rate_limited" : "rejected", message };
  return { ok: false, code: "uncertain", message };
}

/** The order host (the SDK's production CLOB), and how often a request keeps a connection to it open. */
const CLOB = "https://clob.polymarket.com";
const WARM_MS = 2500;

export type CancelAnswer = { ok: boolean; reason: string };

/** The API secret as the SDK decodes it for its L2 signature (base64url → bytes, anything else dropped), once. */
export function l2Key(secret: string): Buffer {
  return Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
}

/** The CLOB's L2 signature (POLY_SIGNATURE) exactly as the SDK computes it: HMAC-SHA256 of timestamp (s) + method + path
 *  + body under the decoded secret, base64 with + / → - _ (padding kept). Synchronous node:crypto in place of the SDK's
 *  WebCrypto importKey + sign (async, on the libuv threadpool the archive's gzip also uses). */
export function l2Signature(key: Buffer, ts: number, method: string, path: string, body?: string): string {
  return crypto.createHmac("sha256", key).update(`${ts}${method}${path}${body ?? ""}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

/** L2 credentials and the address that signs with them: POLY_ADDRESS is the signer (the key's EOA), not the wallet. */
export interface L2Creds { key: string; secret: string; passphrase: string; address: string }

/** LIVE_CANCEL_HTTP=own: one cancel by id on the bot's own request. The same DELETE /order the SDK's cancelOrder sends
 *  (body {"orderID"}, content-type and the five POLY_* headers; the self-test compares the two requests byte for byte),
 *  without its per-request key import, ky and zod. An HTTP 200 → the answer ({canceled, not_canceled}); anything else →
 *  { status, text } for the caller to fall back to the SDK. Throws when no answer came (network), or none within
 *  timeoutMs: ky's default 10 s, which the SDK path has and the live exchange's cancel retry relies on (a bare fetch
 *  would wait minutes, leaving the order "cancelling" and fillable). */
export function ownCanceller(c: L2Creds, f: typeof fetch = fetch, now: () => number = Date.now, timeoutMs = 10_000):
    (orderId: string) => Promise<CancelAnswer | { status: number; text: string }> {
  const key = l2Key(c.secret);
  return async (orderId) => {
    const body = JSON.stringify({ orderID: orderId }), ts = Math.floor(now() / 1000);
    // a ref'd timer (AbortSignal.timeout's is unref'd), cleared once the answer is read: the body can hang too
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(new DOMException(`no answer in ${timeoutMs} ms`, "TimeoutError")), timeoutMs);
    let r: Response, text: string;
    try {
      r = await f(`${CLOB}/order`, { method: "DELETE", body, signal: ac.signal, headers: {
        "content-type": "application/json", POLY_ADDRESS: c.address, POLY_API_KEY: c.key, POLY_PASSPHRASE: c.passphrase,
        POLY_SIGNATURE: l2Signature(key, ts, "DELETE", "/order", body), POLY_TIMESTAMP: String(ts) } });
      text = await r.text();
    } finally { clearTimeout(timer); }
    if (r.status !== 200) return { status: r.status, text };
    let j: any;
    try { j = JSON.parse(text); } catch { return { status: r.status, text }; }
    if ((j?.canceled ?? []).map(String).includes(orderId)) return { ok: true, reason: "" };
    return { ok: false, reason: String(j?.not_canceled?.[orderId] ?? j?.notCanceled?.[orderId] ?? "not cancelled") };
  };
}

/** LIVE_CANCEL_COPIES: one cancel sent n times at once. Resolves at the first copy that cancelled (a copy that answers
 *  "not found" first may only have lost to the other copy); with none, once every copy has answered, the first answer;
 *  rejects only when every copy threw (then the live exchange retries, as for one). */
export function raceCancels(n: number, send: () => Promise<CancelAnswer>): Promise<CancelAnswer> {
  return new Promise((resolve, reject) => {
    let done = false, left = n, err: unknown = null;
    const answers: CancelAnswer[] = [];
    const end = () => {
      if (--left > 0 || done) return;
      done = true;
      if (answers.length) resolve(answers[0]); else reject(err);
    };
    for (let i = 0; i < n; i++) {
      send().then((r) => {
        if (done) return;
        if (r.ok) { done = true; resolve(r); return; }
        answers.push(r); end();
      }, (e) => { if (done) return; err ??= e; end(); });
    }
  });
}

const errText = (e: unknown) => {
  const x = e as { name?: string; message?: string };
  return `${x?.name && x.name !== "Error" ? x.name + ": " : ""}${x?.message ?? String(e)}`.slice(0, 300);
};

/** copies: each order's signed body is posted this many times at once (LIVE_POST_COPIES; racePosts). cancels: each cancel
 *  sent `copies` times at once (LIVE_CANCEL_COPIES; raceCancels), on the bot's own request with `own` (LIVE_CANCEL_HTTP). */
export async function connectVenue(log: (m: string) => void, copies = 1, cancels: { copies?: number; own?: boolean } = {}): Promise<Venue> {
  // the SDK's user channel needs the global WebSocket (Node >= 22; the SDK asks for >= 24). Under v20 it never connects,
  // and the trader then sends nothing (2026-10-13 09:54, started by pm2 under v20.20.2): fail loudly at boot instead.
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 24 || typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "function")
    throw new Error(`MM_MODE=live needs Node >= 24 (this is ${process.version}): start it with tools/start-live.sh / ecosystem.config.cjs, which pick it`);
  const wallet = process.env.POLYMARKET_FUNDER_ADDRESS ?? "";
  if (!wallet) throw new Error("POLYMARKET_FUNDER_ADDRESS is not set (the Deposit Wallet the fills settle into)");
  // the key and its secrets come from the passphrase-unlocked wallet vault (vault.ts), never from .env; index.ts unlocks
  // it before the feeds start, so here it is normally open already
  const ws = await walletSecrets();
  const rk = ws.relayerKey, ra = process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS;
  const gasless = !!(rk && ra);
  const base = { signer: privateKey(ws.privateKey), wallet, ...(gasless ? { apiKey: relayerApiKey({ key: rk, address: ra! }) } : {}) };
  // existing L2 credentials are reused when stored; without them the client derives the account's key at startup
  const client = ws.api
    ? await createSecureClient({ ...base, credentials: ws.api as never })
    : await createSecureClient(base);

  const subs: ((u: VenueOrderUpdate) => void)[] = [];
  const tsubs: ((t: VenueTrade) => void)[] = [];
  let up = false, closed = false, backoff = 1000, downAt = 0;
  let handle: { close(): Promise<void> } | null = null;

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        const h = await client.subscribe([{ topic: "user" }] as const);
        handle = h; up = true; backoff = 1000;
        log("[live] user channel connected");
        for await (const ev of h as AsyncIterable<any>) {
          const rx = Date.now();
          if (ev?.type === "order") {
            const q = ev.payload;
            const u: VenueOrderUpdate = { orderId: String(q.id), type: String(q.orderEventType ?? ""), sizeMatched: Number(q.sizeMatched), status: q.status ?? null,
              tokenId: String(q.tokenId ?? ""), price: Number(q.price), size: Number(q.originalSize), ts: epochMs(q.timestamp), rx };
            for (const cb of subs) { try { cb(u); } catch (e) { log(`[live] order handler: ${errText(e)}`); } }
          } else if (ev?.type === "trade") {
            const t = { ...venueTrade(ev.payload), rx };
            if (/FAILED|RETRYING/.test(t.status)) log(`[live] ⚠ trade ${t.tradeId} ${t.status} on chain (${ev.payload?.size} @ ${ev.payload?.price}): check the wallet's positions`);
            for (const cb of tsubs) { try { cb(t); } catch (e) { log(`[live] trade handler: ${errText(e)}`); } }
          }
        }
        log("[live] user channel ended");
      } catch (e) {
        log(`[live] user channel: ${errText(e)}`);
      }
      up = false; handle = null; downAt = Date.now();
      if (closed) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  };
  void run();

  const tx = async (what: string, h: { wait(): Promise<{ transactionHash: string }> }) => {
    const out = await h.wait();
    log(`[live] ${what}: ${out.transactionHash}`);
    return out.transactionHash ?? null;
  };

  if (!gasless) log("[live] no POLYMARKET_RELAYER_API_KEY / _ADDRESS: merges and redeems are not sent (do them on polymarket.com)");
  // keep a connection to the order host open, one for each copy of a post or a cancel: Node's fetch closes one idle for
  // 4 s, and the next order then waits for a new one (a GET after 6 s idle took ~35 ms, warm ~27, 2026-10-14); requests
  // sent at once each take their own connection (the SDK's ky and the own cancel path both ride the global fetch)
  const cancelCopies = Math.max(1, Math.round(cancels.copies ?? 1)), warmN = Math.max(copies, cancelCopies);
  const warm = setInterval(() => {
    if (closed) return;
    for (let i = 0; i < warmN; i++) fetch(`${CLOB}/time`).then((r) => r.arrayBuffer(), () => null).catch(() => null);
  }, WARM_MS);
  warm.unref();
  // one signed body to the venue: its answer, or a refusal / "uncertain" from what it threw
  const postSigned = async (signed: unknown, take: boolean): Promise<PostResult> => {
    try {
      const r: any = await client.postOrder(signed as never);
      if (r?.ok) return take ? { ok: true, orderId: String(r.orderId), status: String(r.status), making: Number(r.makingAmount), taking: Number(r.takingAmount) }
        : { ok: true, orderId: String(r.orderId), status: String(r.status) };
      return { ok: false, code: String(r?.code ?? "rejected"), message: String(r?.message ?? "") };
    } catch (e) {
      // the venue answered with a refusal (HTTP 4xx, e.g. "invalid post-only order: order crosses book", 123 times on
      // 2026-10-13, or a rate limit): the order does not exist. Anything else (no answer, an unreadable one) may have
      // reached the venue: the live exchange watches the user channel for it.
      return postFailure((e as { name?: string })?.name ?? "", errText(e));
    }
  };
  const send = (signed: unknown, take: boolean) => (copies > 1 ? racePosts(copies, () => postSigned(signed, take), log) : postSigned(signed, take));

  // ---- cancels: the SDK's cancelOrder, or the own request (LIVE_CANCEL_HTTP=own) falling back to it; n copies at once ----
  const sdkCancel = async (orderId: string): Promise<CancelAnswer> => {
    const r: any = await client.cancelOrder({ orderId });
    if ((r?.canceled ?? []).map(String).includes(orderId)) return { ok: true, reason: "" };
    return { ok: false, reason: String(r?.notCanceled?.[orderId] ?? "not cancelled") };
  };
  // the own path signs with the client's own L2 credentials (stored, or derived at startup) as the SDK does
  const cred = (client as { credentials?: { key?: string; secret?: string; passphrase?: string } }).credentials;
  const signer = (client as { account?: { signer?: string } }).account?.signer;
  let own = cancels.own && cred?.key && cred.secret && cred.passphrase && signer
    ? ownCanceller({ key: cred.key, secret: cred.secret, passphrase: cred.passphrase, address: signer }) : null;
  if (cancels.own) log(own ? `[live] LIVE_CANCEL_HTTP=own: cancels on the bot's own request (falls back to the SDK on anything but HTTP 200)`
    : "[live] ⚠ LIVE_CANCEL_HTTP=own: the client carries no L2 credentials or signer, so cancels stay on the SDK");
  if (cancelCopies > 1) log(`[live] LIVE_CANCEL_COPIES=${cancelCopies}: each cancel sent ${cancelCopies} times at once, done at the first that cancelled`);
  let ownFails = 0;
  const cancelOnce = async (orderId: string): Promise<CancelAnswer> => {
    if (own) {
      try {
        const r = await own(orderId);
        if ("ok" in r) return r;
        // refused: the SDK sends the same cancel (its own errors, as before). A 401/403 means the signature or the key
        // is wrong: the own path is off for the rest of the run
        if (r.status === 401 || r.status === 403) { own = null; log(`[live] ⚠ own cancel refused HTTP ${r.status} (${r.text.slice(0, 160)}): cancels back on the SDK for this run`); }
        else if (++ownFails <= 3 || ownFails % 100 === 0) log(`[live] own cancel …${orderId.slice(-8)} answered HTTP ${r.status} (${r.text.slice(0, 120)}): sent again by the SDK (${ownFails} so far)`);
      } catch (e) {
        if (++ownFails <= 3 || ownFails % 100 === 0) log(`[live] own cancel …${orderId.slice(-8)}: ${errText(e)}: sent again by the SDK (${ownFails} so far)`);
      }
    }
    return sdkCancel(orderId);
  };
  return {
    wallet,
    gasless,
    connected: () => up,
    lastDown: () => (up ? downAt : Date.now()),
    async postBid(tokenId, price, size, onSigned) {
      const t0 = Date.now();
      let signed;
      try { signed = await client.createLimitOrder({ tokenId, price, size, side: OrderSide.BUY, postOnly: true }); }
      catch (e) { return { ok: false, code: "unsigned", message: errText(e), signMs: Date.now() - t0 }; }     // never left this process
      const signMs = Date.now() - t0;
      if (onSigned) { const id = orderId(signed); if (id) onSigned(id); }
      return { ...(await send(signed, false)), signMs };
    },
    async postTake(tokenId, usd, maxPrice) {
      const t0 = Date.now();
      let signed;
      try { signed = await client.createMarketOrder({ tokenId, side: OrderSide.BUY, amount: usd, maxPrice, orderType: OrderType.FAK }); }
      catch (e) { return { ok: false, code: "unsigned", message: errText(e), signMs: Date.now() - t0 }; }     // never left this process
      const signMs = Date.now() - t0;
      return { ...(await send(signed, true)), signMs };
    },
    async warm(tokenIds) {
      await Promise.all(tokenIds.map((tokenId) => client.createMarketOrder({ tokenId, side: OrderSide.BUY, amount: 1, maxPrice: 0.5, orderType: OrderType.FAK })
        .then(() => {}, (e: unknown) => log(`[live] warming …${tokenId.slice(-8)}: ${errText(e)}`))));
    },
    cancel(orderId) {
      return cancelCopies > 1 ? raceCancels(cancelCopies, () => cancelOnce(orderId)) : cancelOnce(orderId);
    },
    async cancelMany(orderIds) {
      if (!orderIds.length) return 0;
      const r: any = await client.cancelOrders({ orderIds });
      return (r?.canceled ?? []).length;
    },
    async fetchOrder(orderId) {
      try {
        const o: any = await client.fetchOrder({ orderId });
        return { sizeMatched: Number(o.sizeMatched), status: String(o.status) };
      } catch (e) {
        const c = (e as { cause?: { message?: string } })?.cause?.message ?? "";
        if ((e as { name?: string })?.name === "UnexpectedResponseError" && /received null/.test(c)) return "gone";
        log(`[live] fetch order …${orderId.slice(-8)}: ${errText(e)}`);
        return null;
      }
    },
    async matched(market, orderIds) {
      const want = new Set(orderIds), out = new Map<string, number>();
      for await (const page of client.listAccountTrades({ market }) as AsyncIterable<{ items: any[] }>) {
        for (const t of page.items) {
          if (/FAILED/i.test(String(t.status ?? ""))) continue;
          for (const m of t.makerOrders ?? []) {
            const id = String(m.orderId);
            if (want.has(id)) out.set(id, (out.get(id) ?? 0) + Number(m.matchedAmount));
          }
          const tid = String(t.takerOrderId ?? "");
          if (want.has(tid) && t.traderSide === "TAKER") out.set(tid, (out.get(tid) ?? 0) + Number(t.size));
        }
      }
      return out;
    },
    async balance() {
      const r: any = await fetchBalanceAllowance(client as never, { assetType: "COLLATERAL" as never });
      return Number(r.balance) / 1e6;
    },
    async tokenBalance(tokenId) {
      const r: any = await fetchBalanceAllowance(client as never, { assetType: "CONDITIONAL" as never, tokenId });
      return Number(r.balance) / 1e6;
    },
    async merge(conditionId, pairs) {
      // our pairs only (6-decimal base units), not "max": another bot on the wallet may hold tokens of the same market
      const amount = BigInt(Math.floor(pairs * 1e6 + 1e-6));
      if (amount <= 0n) return null;
      return tx(`merged ${pairs} pairs of …${conditionId.slice(-8)}`, await client.mergePositions({ amount, conditionId }) as never);
    },
    async redeem(conditionId) {
      return tx(`redeemed …${conditionId.slice(-8)}`, await client.redeemPositions({ conditionId }) as never);
    },
    onOrder(cb) { subs.push(cb); },
    onTrade(cb) { tsubs.push(cb); },
    async close() { closed = true; clearInterval(warm); try { await handle?.close(); } catch { /* */ } },
  };
}
