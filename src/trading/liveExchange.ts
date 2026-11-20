// LIVE EXCHANGE — the paper exchange's interface on the real Polymarket CLOB (MM_MODE=live). REAL MONEY.
//
// Place     a post-only GTC BUY of the token at its price is signed and posted (venue.ts). The order is "pending" until
//           the venue answers: accepted → "open", its queue0 the others' size at its level on the next step; refused
//           (post_only_would_cross, balance, tick, ...) → "rejected" with the venue's reason.
// Cancel    sent at once if the venue id is known, else as soon as the post is answered. The order stays "cancelling"
//           (still fillable, as on the venue) until the venue confirms. A cancel the venue refuses (matched in full, or
//           gone) is settled from the order's own record; a network error retries.
// Early     LIVE_EARLY_CANCEL=on: the venue id is the order's hash, known once it is signed (venue.ts onSigned), so a cancel
//           decided while the post is in flight goes out at once by that id instead of waiting for the answer (live 10-23:
//           20% of orders were cancelled before their answer, waiting a median 33 ms, p90 154; 17 of 23 fills with a cancel
//           were such orders). "canceled" → cancelled (the post's answer, when it comes, only completes the timing line).
//           Anything else while the post is unanswered means the cancel beat the post: the venue then refuses the post
//           "Already canceled" → cancelled, never on the book; a post placed after all gets its cancel by id at the answer,
//           as without the switch. Real 1¢ orders, 2026-10-29 (reports/Speeding up the cancel.md): 48 of 48 early cancels
//           that beat their post had it refused, on BTC-move bursts too (posts up to 785 ms); none left an order resting.
// Fills     from the user channel: an `order` event carries the order's cumulative size_matched, so a fill is the rise
//           since the last one booked; a repeated or out-of-order event books nothing. An event that beats the post's
//           HTTP answer (the feed is ~10 ms faster, 2026-10-12) is held until the id is known. Fills are booked at our
//           limit price: post-only orders only ever make.
// Records   every working order not heard of on the user channel for POLL_MS is read back over REST, and so is an order
//           whose cancel the venue refused, or that was cancelled after resting through a user-channel drop: a fill the
//           channel never delivered is still booked (fills are idempotent: cumulative size_matched). A resting order's
//           record gives its size_matched; one off the book has no record ("gone"), and its fills are summed from the
//           account's trades of its market.
// Lost post a post that threw on the way (timeout, dropped connection) may still have reached the venue: the order stays
//           "pending" for ORPHAN_MS and is adopted if the user channel shows a placement of the same token, price and
//           size; else it is rejected.
// Sharing   the wallet may be traded by another bot (pmqb) or by hand: an order this run did not post is left alone, and
//           every cancel names its order (no cancel-all).
// Own book  own(asset) is our resting size per level, which pmBook takes out of every view: the quoter, the order
//           manager's race rules and the flow FV see the book without us, as on paper.
// Takes     the pair trade's legs (pairTrader.ts): a fill-and-kill market BUY of the order's USDC budget (Order.usd, else
//           size × limit) at prices up to its limit. Booked from the post's answer ("matched": the USDC spent and the
//           shares bought, at their average price; the taker fee 0.07·p(1−p) a share on top, as on paper), else from the
//           user channel's `trade` events (FAK orders send no `order` events), and an answer without amounts ("delayed")
//           is finished from the order's record after POLL_MS. A take that threw on the way is adopted if a taker trade of
//           its token shows within ORPHAN_MS (else rejected: the wallet check is the backstop). Takes never rest, so they
//           are not cancelled and not in own(). (v4's flow and rebalance takes go the same way; they are off.)
// Timing    TIMING_WAIT_MS after an order is over, an `info` event (archived with the window) and a log line say where its
//           time went, in ms after it was sent: signing here, the venue's placement event (a bid) and first match (its
//           order event, or a take's trade), each by the venue's clock (v) and its arrival here (h), the post's answer and
//           the cancel's round trip, and with LIVE_POST_COPIES each copy's answer (ok, dup, …). Why: a post's answer took over 800 ms on 10% of the bids (2026-10-15; #1412 1132 ms,
//           its leg 2 1116 ms) against a median of ~120 ms, and the answer alone can't tell the venue from the way back.
import { priceKey, type BookView, type OwnLevels, type Print } from "../feeds/pmBook.js";
import type { Exchange } from "./exchange.js";
import { cancelKind, r4, type Emit, type Fill, type Order, type Side } from "./types.js";
import { levelSize, takerFee, type PlaceReq } from "./paperExchange.js";
import type { PostResult, RaceInfo, Venue, VenueOrderUpdate, VenueTrade } from "./venue.js";

/** Finished orders stay visible this long, then leave the working set. */
const LINGER_MS = 3000;
/** A finished order's venue id stays known this long, for fill events that arrive after its cancel. */
const KEEP_MS = 15 * 60_000;
/** A post that threw waits this long for its placement to show on the user channel, then counts as refused (its side
 *  shows "in flight" meanwhile, so nothing else is placed there). */
export const ORPHAN_MS = 10_000;
/** Events for ids we do not know are held this long (a slow post answer still finds its fills), then dropped. */
const EARLY_KEEP_MS = 120_000;
const CANCEL_RETRY_MS = 500;
/** A working order with no event for this long is read back over REST. */
const POLL_MS = 3000;
/** An order's timing line waits this long after it is over: a fill's event can trail the order's end. */
const TIMING_WAIT_MS = 1000;

/** Where an order's time went (epoch ms; `ts` on the venue's clock, `rx` when its event arrived here). */
interface Timing {
  sign: number | null; answer: number | null;
  placed: { ts?: number; rx: number } | null;
  /** The first match: `via` the order event's type, a take's trade status, or RECORD / TRADES for a REST read. */
  match: { ts?: number; rx: number; via: string } | null;
  cxlSent: number | null; cxlAns: number | null;
  /** The cancel went by the signed id, before the post's answer (LIVE_EARLY_CANCEL). */
  cxlEarly: boolean;
  /** LIVE_POST_COPIES: each copy's answer (still filling in as late copies answer). */
  race: RaceInfo | null;
}

interface Meta {
  xid: string | null; tokenId: string; otherId: string; cond: string | null; cancelSent: boolean; tries: number; uncertain: { until: number; why: string } | null;
  /** LIVE_EARLY_CANCEL: the venue id computed when the order was signed, and whether a cancel went out by it. */
  pre: string | null; earlySent: boolean;
  /** MM_CANCEL_DELAY_MS: the cancel goes no earlier than this (ms since epoch). */
  cxlAfter?: number;
  /** Last event (or REST read) for the order, and whether a REST read is in flight. */
  heard: number; polling: boolean;
  /** A take: the USDC booked so far (its shares are the order's `filled`), and its trades from the user channel by id. */
  cost: number; trades: Map<string, VenueTrade> | null;
}

export class LiveExchange implements Exchange {
  private orders = new Map<number, Order>();
  private meta = new Map<number, Meta>();
  private byX = new Map<string, Order>();
  private early = new Map<string, { at: number; u: VenueOrderUpdate[]; told: boolean }>();
  /** Taker trades of order ids we do not know yet: a take's trade beats its post's answer (by ~2 ms, 2026-10-14). */
  private earlyT = new Map<string, { at: number; tokenId: string; t: Map<string, VenueTrade>; told: boolean }>();
  /** px: a take's token price for this fill (makers fill at their limit). */
  private fills: { o: Order; size: number; t: number; px?: number }[] = [];
  /** Accepted since the last step: their queue and the "live" event are set on the next step's book. */
  private acks: Order[] = [];
  private upTok: string | null = null;
  private dnTok: string | null = null;
  private cond: string | null = null;
  nextId: number;
  nextFillId: number;
  /** Venue round trips (ms) of the last posts and cancels, and the posts' signing, for the log. */
  readonly lat = { post: [] as number[], cancel: [] as number[], sign: [] as number[] };
  /** Orders sent to the venue whose timing line is still to come. */
  private tm = new Map<number, Timing>();

  /** earlyCancel: LIVE_EARLY_CANCEL (header, "Early"). */
  constructor(private readonly venue: Venue, private readonly emit: Emit, private readonly log: (m: string) => void,
              startId = 1, startFillId = 1, private readonly now: () => number = Date.now, private readonly earlyCancel = false,
              private readonly cancelDelayMs = 0) {
    this.nextId = startId;
    this.nextFillId = startFillId;
    venue.onOrder((u) => this.onUpdate(u));
    venue.onTrade((t) => this.onTrade(t));
  }

  setTokens(up: string | null, down: string | null, cond: string | null = null): void {
    // a new window: its tokens' markets cached for signing now, not on the first order (a take's ~1 s)
    if (up && down && (up !== this.upTok || down !== this.dnTok)) {
      const t0 = this.now();
      this.venue.warm([up, down]).then(() => this.log(`[live] the window's tokens are ready to sign (${this.now() - t0} ms)`), () => {});
    }
    this.upTok = up; this.dnTok = down; this.cond = cond;
  }

  onPrint(_p: Print): void { /* the venue matches */ }

  place(req: PlaceReq, now: number): Order {
    const token = req.token ?? "UP", tokenSide = req.side ?? "BUY", tokenPrice = r4(req.price);
    const side: Side = token === "UP" ? tokenSide : tokenSide === "BUY" ? "SELL" : "BUY";
    const o: Order = {
      id: this.nextId++, win: req.win, side, price: token === "UP" ? tokenPrice : r4(1 - tokenPrice), token, tokenSide, tokenPrice,
      size: req.size, filled: 0, status: "pending", reason: req.reason, createdAt: now, ackDue: now, liveAt: null, cancelDue: null,
      doneAt: null, queue: 0, queue0: 0, lv: [], crossUsed: 0, take: !!req.take,
      // a take spends USDC: whole cents, as the venue signs a market BUY's amount
      ...(req.take ? { usd: Math.max(0.01, Math.round((req.usd ?? req.size * tokenPrice) * 100) / 100) } : {}),
    };
    this.orders.set(o.id, o);
    this.emit({ t: now, win: o.win, oid: o.id, type: "place", side: o.side, price: o.price, size: o.size,
      note: req.reason + (o.usd != null ? ` · fill-and-kill, $${o.usd.toFixed(2)}` : ""), ...evTok(o) });
    const tokenId = token === "UP" ? this.upTok : this.dnTok, otherId = token === "UP" ? this.dnTok : this.upTok;
    const refuse = tokenSide !== "BUY" ? "live sends BUYs only" : !tokenId || !otherId ? "no token id for this window" : null;
    if (refuse) { this.finish(o, "rejected", now, refuse); return o; }
    this.meta.set(o.id, { xid: null, tokenId: tokenId!, otherId: otherId!, cond: this.cond, cancelSent: false, tries: 0, uncertain: null, pre: null, earlySent: false,
      heard: now, polling: false, cost: 0, trades: o.take ? new Map() : null });
    this.tm.set(o.id, { sign: null, answer: null, placed: null, match: null, cxlSent: null, cxlAns: null, cxlEarly: false, race: null });
    const fail = (e: unknown) => ({ ok: false as const, code: "error", message: String(e) });
    if (o.take) this.venue.postTake(tokenId!, o.usd!, tokenPrice).then((r) => this.onTaken(o, r), (e) => this.onTaken(o, fail(e)));
    else this.venue.postBid(tokenId!, tokenPrice, o.size, this.earlyCancel ? (id) => this.onSigned(o, id) : undefined)
      .then((r) => this.onPosted(o, r), (e) => this.onPosted(o, fail(e)));
    return o;
  }

  /** LIVE_EARLY_CANCEL: the order is signed and about to be sent; a cancel decided meanwhile goes now, ahead of the post. */
  private onSigned(o: Order, id: string): void {
    const m = this.meta.get(o.id);
    if (!m) return;
    m.pre = id;
    if (o.status === "cancelling") this.sendCancel(o);
  }

  // ---- takes ---------------------------------------------------------------------------------------
  private onTaken(o: Order, r: PostResult): void {
    const now = this.now(), m = this.meta.get(o.id);
    if (!m || !active(o) || m.xid) return;
    push(this.lat.post, now - o.createdAt);
    this.answered(o, r, now);
    if (!r.ok && r.code === "uncertain") {
      m.uncertain = { until: now + ORPHAN_MS, why: r.message };
      this.log(`[live] take #${o.id} threw (${r.message}); watching the user channel for its trades`);
      for (const [xid, e] of this.earlyT) if (e.tokenId === m.tokenId) { this.adoptTake(o, xid); break; }
      return;
    }
    m.uncertain = null;
    if (!r.ok) { this.finish(o, "rejected", now, `venue: ${r.code}${r.message ? ` · ${r.message}` : ""} · after ${now - o.createdAt} ms`); return; }
    m.xid = r.orderId; m.heard = now;
    this.byX.set(r.orderId, o);
    o.liveAt = now;
    if (o.status === "pending") o.status = "open";
    const held = this.earlyT.get(r.orderId);
    if (held) { this.earlyT.delete(r.orderId); for (const t of held.t.values()) this.takeTrade(o, t); }
    if (r.status.toLowerCase() === "matched" && Number.isFinite(r.taking) && Number.isFinite(r.making)) {
      this.bookTake(o, r.taking!, r.making!, now);
      this.endTake(o, now, `answered in ${now - o.createdAt} ms`);
    }
    // anything else ("delayed"): its trades book it as they come, and its record finishes it (step, POLL_MS)
  }

  private adoptTake(o: Order, xid: string): void {
    this.log(`[live] take #${o.id} reached the venue after all (…${xid.slice(-8)}): adopted`);
    this.onTaken(o, { ok: true, orderId: xid, status: "adopted" });
  }

  private onTrade(t: VenueTrade): void {
    if (!t.taker || !t.takerOrderId || /FAILED/.test(t.status)) return;
    const o = this.byX.get(t.takerOrderId);
    if (o) { this.takeTrade(o, t); return; }
    const e = this.earlyT.get(t.takerOrderId) ?? { at: this.now(), tokenId: t.tokenId, t: new Map(), told: false };
    e.t.set(t.tradeId, t);
    this.earlyT.set(t.takerOrderId, e);
    for (const x of this.orders.values()) {
      const m = this.meta.get(x.id);
      if (x.take && m?.uncertain && !m.xid && m.tokenId === t.tokenId) { this.adoptTake(x, t.takerOrderId); break; }
    }
  }

  /** A take's trade (each of its statuses arrives; counted once by id): books what the trades add up to beyond the booked. */
  private takeTrade(o: Order, t: VenueTrade): void {
    const m = this.meta.get(o.id);
    if (!m?.trades) return;
    const tm = this.tm.get(o.id);
    if (tm && !tm.match) tm.match = { ts: t.ts, rx: t.rx ?? this.now(), via: t.status };
    m.trades.set(t.tradeId, t);
    let q = 0, c = 0;
    for (const x of m.trades.values()) { q += x.size; c += x.cost; }
    this.bookTake(o, q, c, this.now());
  }

  /** Cumulative: the take has bought `qty` shares for `cost` USDC in all; the rise over what is booked is a fill. */
  private bookTake(o: Order, qty: number, cost: number, now: number): void {
    const m = this.meta.get(o.id);
    if (!m || !(qty > o.filled + 1e-6)) return;
    const got = Math.round((qty - o.filled) * 1e6) / 1e6, px = Math.min(o.tokenPrice, Math.max(0.001, (cost - m.cost) / (qty - o.filled)));
    o.filled = qty; m.cost = Math.max(cost, m.cost);
    this.fills.push({ o, size: got, t: now, px });
  }

  /** The take is over (its answer, or its record): filled if the budget went, else the rest was killed. */
  private endTake(o: Order, now: number, why: string): void {
    if (!active(o)) return;
    const m = this.meta.get(o.id), spent = m?.cost ?? 0, budget = o.usd ?? o.size * o.tokenPrice;
    const avg = o.filled > 1e-9 ? ` @ ${cents(spent / o.filled)}` : "";
    if (budget - spent < 0.01) this.finish(o, "filled", now, null);
    else this.finish(o, "cancelled", now, `fill-and-kill: ${fmtSh(o.filled)} sh${avg} for $${spent.toFixed(2)} of $${budget.toFixed(2)}; the rest found nothing within ${cents(o.tokenPrice)} · ${why}`);
  }

  /** A take whose answer had no amounts: its record says when it is over; shares the trades did not show are booked at its limit. */
  private settleTake(o: Order): Promise<void> {
    const m = this.meta.get(o.id), xid = m?.xid;
    if (!m || !xid) return Promise.resolve();
    return this.venue.fetchOrder(xid).then(async (r) => {
      if (!active(o)) return;
      let matched: number | null = null;
      if (r && r !== "gone") { if (/^(LIVE|DELAYED)$/i.test(r.status)) return; matched = r.sizeMatched; }
      else if (r === "gone" && m.cond) {
        try { matched = (await this.venue.matched(m.cond, [xid])).get(xid) ?? 0; } catch (e) { this.log(`[live] trades of …${m.cond.slice(-8)}: ${String(e).slice(0, 160)}`); }
      }
      if (matched == null || !active(o)) return;
      if (matched > o.filled + 1e-6) this.bookTake(o, matched, m.cost + (matched - o.filled) * o.tokenPrice, this.now());
      this.endTake(o, this.now(), `its record: ${matched} matched`);
    });
  }

  private onPosted(o: Order, r: PostResult): void {
    const now = this.now(), m = this.meta.get(o.id);
    if (!m) return;
    // already over: an adoption's repeat, or an early cancel that took it off before this answer (its timing line's answer)
    if (!active(o)) { if (o.status === "cancelled" && m.xid != null && m.xid === m.pre) this.answered(o, r, now); return; }
    push(this.lat.post, now - o.createdAt);
    this.answered(o, r, now);
    if (!r.ok && r.code === "uncertain") {
      m.uncertain = { until: now + ORPHAN_MS, why: r.message };
      this.log(`[live] post #${o.id} threw (${r.message}); watching the user channel for it`);
      for (const [xid, e] of this.early) if (e.u.some((u) => this.isPost(o, m, u))) { this.adopt(o, xid); break; }
      return;
    }
    m.uncertain = null;
    if (!r.ok) {
      // LIVE_EARLY_CANCEL: our cancel by the signed id reached the venue before this post, which it then refuses
      if (m.earlySent && /already cancel/i.test(r.message)) {
        this.finish(o, "cancelled", now, `the cancel beat the post: the venue refused it (already canceled) after ${now - o.createdAt} ms · ${fmtFill(o)} · never reached the book`);
        return;
      }
      this.finish(o, "rejected", now, `venue: ${r.code}${r.message ? ` · ${r.message}` : ""} · after ${now - o.createdAt} ms`);
      return;
    }
    m.xid = r.orderId;
    m.heard = now;
    this.byX.set(r.orderId, o);
    o.liveAt = now; o.ackDue = now;
    if (o.status === "pending") o.status = "open";
    this.acks.push(o);
    const held = this.early.get(r.orderId);
    if (held) { this.early.delete(r.orderId); for (const u of held.u) this.onUpdate(u); }
    if (o.status === "cancelling") this.sendCancel(o);
  }

  /** The post's first answer (an adoption's later one is not the venue's): when, and how long signing took. */
  private answered(o: Order, r: PostResult, now: number): void {
    const t = this.tm.get(o.id);
    if (!t || t.answer != null) return;
    t.answer = now; t.sign = r.signMs ?? null; t.race = r.race ?? null;
    if (r.signMs != null) push(this.lat.sign, r.signMs);
  }

  /** u is the placement of the post that threw: same token, price and size. */
  private isPost(o: Order, m: Meta, u: VenueOrderUpdate): boolean {
    return u.tokenId === m.tokenId && u.price != null && Math.abs(u.price - o.tokenPrice) < 1e-9 && u.size != null && Math.abs(u.size - o.size) < 1e-6;
  }

  private adopt(o: Order, xid: string): void {
    this.log(`[live] post #${o.id} reached the venue after all (…${xid.slice(-8)}): adopted`);
    this.onPosted(o, { ok: true, orderId: xid, status: "live" });
  }

  cancel(o: Order, now: number, why: string): void {
    if (o.take || (o.status !== "pending" && o.status !== "open")) return;      // a take ends by itself
    o.status = "cancelling";
    o.cancelDue = now;
    o.cancelWhy = why;
    o.cancelAt = now;          // the cancel was decided: a fill from here on is "cancel in flight" (Fill.cxl), whatever the status is by then
    const m = this.meta.get(o.id);
    const delay = this.cancelDelayMs > 0 && m ? this.cancelDelayMs : 0;
    this.emit({ t: now, win: o.win, oid: o.id, type: "cancel", side: o.side, price: o.price, size: o.size - o.filled,
      note: delay ? `${why} · sent after the ${delay} ms cancel delay` : why, ...evTok(o) });
    // MM_CANCEL_DELAY_MS: the order stays on the venue that much longer; the order manager already counts it as cancelling
    if (delay) { m!.cxlAfter = this.now() + delay; setTimeout(() => this.sendCancel(o), delay); return; }
    this.sendCancel(o);      // waits for the venue id if the post is still in flight (LIVE_EARLY_CANCEL: goes by the signed id)
  }

  private sendCancel(o: Order): void {
    const m = this.meta.get(o.id);
    const xid = m?.xid ?? (this.earlyCancel ? m?.pre ?? null : null);
    if (!m || !xid || m.cancelSent || !active(o)) return;
    if (m.cxlAfter != null && this.now() < m.cxlAfter) return;           // MM_CANCEL_DELAY_MS: its timer sends it
    m.cancelSent = true;
    const early = !m.xid, sent = this.now(), tm = this.tm.get(o.id);
    if (early) m.earlySent = true;
    if (tm && tm.cxlSent == null) { tm.cxlSent = sent; tm.cxlEarly = early; }
    this.venue.cancel(xid).then((r) => {
      push(this.lat.cancel, this.now() - sent);
      if (tm && tm.cxlAns == null) tm.cxlAns = this.now();
      if (!active(o)) return;
      if (r.ok) {
        if (!m.xid) {
          // placed, and cancelled before its post's answer: its events (a fill before the cancel) now find the order
          m.xid = xid; this.byX.set(xid, o);
          const held = this.early.get(xid);
          if (held) {
            this.early.delete(xid);
            const pl = held.u.find((u) => u.type === "PLACEMENT");          // it did rest: its notes say for how long
            if (pl && o.liveAt == null) o.liveAt = pl.rx ?? this.now();
            for (const u of held.u) this.onUpdate(u);
          }
          if (!active(o)) return;
          this.finish(o, "cancelled", this.now(), `${fmtFill(o)}${o.liveAt != null ? restWords(o, this.now()) : ""} · cancelled before its post was answered · cancel took ${this.now() - sent} ms`);
        } else this.finish(o, "cancelled", this.now(), `${fmtFill(o)}${restWords(o, this.now())} · cancel took ${this.now() - sent} ms`);
        // the user channel was down while it rested: a fill of that time never arrived, so read the final record
        if (this.venue.lastDown() >= o.createdAt - 1000) this.settle(o, "cancelled after a user-channel drop");
        return;
      }
      // sent by the signed id and the post is still unanswered: the cancel most likely beat the post, which the venue then
      // refuses "Already canceled" (onPosted); a post placed after all gets its cancel by id at its answer
      if (!m.xid) { m.cancelSent = false; return; }
      this.settle(o, `the venue refused the cancel (${r.reason})`);
    }, (e) => {
      m.cancelSent = false;
      if (++m.tries <= 20) { this.log(`[live] cancel #${o.id} failed (${String(e).slice(0, 160)}), retrying`); setTimeout(() => this.sendCancel(o), CANCEL_RETRY_MS); }
      else this.log(`[live] ⚠ cancel #${o.id} …${xid.slice(-8)} failed 20 times: check the open orders on polymarket.com`);
    });
  }

  /** The venue's records decide what happened to the order: its own record while it rests (a cancelling one gets its
   *  cancel again), else the account's trades of its market (then it is off the book: filled, or cancelled). A failed
   *  read leaves a refused cancel's order cancelled and anything else as it was. */
  private settle(o: Order, why: string, quiet = false): Promise<void> {
    const m = this.meta.get(o.id), xid = m?.xid;
    if (!m || !xid) return Promise.resolve();
    return this.venue.fetchOrder(xid).then(async (r) => {
      if (r && r !== "gone") {
        this.onUpdate({ orderId: xid, type: "RECORD", sizeMatched: r.sizeMatched, status: r.status });
        if (active(o) && o.status === "cancelling" && r.status.toUpperCase() === "LIVE") { m.cancelSent = false; this.sendCancel(o); }
        else if (active(o) && r.status.toUpperCase() !== "LIVE") this.finish(o, "cancelled", this.now(), `${why} · ${fmtFill(o)} · venue status ${r.status}`);
        return;
      }
      if (r === "gone" && m.cond) {
        try {
          const got = (await this.venue.matched(m.cond, [xid])).get(xid) ?? 0;
          this.onUpdate({ orderId: xid, type: "TRADES", sizeMatched: got, status: null });
        } catch (e) { this.log(`[live] trades of …${m.cond.slice(-8)}: ${String(e).slice(0, 160)}`); }
      }
      if (active(o) && (r === "gone" || !quiet)) this.finish(o, "cancelled", this.now(), `${why} · off the book · ${fmtFill(o)}`);
    });
  }

  private onUpdate(u: VenueOrderUpdate): void {
    const o = this.byX.get(u.orderId);
    if (!o) {                     // the post's answer is still on its way, or not an order of this run
      const e = this.early.get(u.orderId) ?? { at: this.now(), u: [], told: false };
      e.u.push(u);
      this.early.set(u.orderId, e);
      for (const x of this.orders.values()) {
        const m = this.meta.get(x.id);
        if (m?.uncertain && !m.xid && this.isPost(x, m, u)) { this.adopt(x, u.orderId); break; }
      }
      return;
    }
    const now = this.now();
    const mm = this.meta.get(o.id), tm = this.tm.get(o.id);
    if (mm) mm.heard = now;
    if (tm && !tm.placed && u.type === "PLACEMENT") tm.placed = { ts: u.ts, rx: u.rx ?? now };
    const matched = Math.min(o.size, u.sizeMatched);
    if (Number.isFinite(matched) && matched > o.filled + 1e-6) {
      if (tm && !tm.match) tm.match = { ts: u.ts, rx: u.rx ?? now, via: u.type };
      const got = Math.round((matched - o.filled) * 1e6) / 1e6;
      o.filled = matched;
      this.fills.push({ o, size: got, t: now });
    }
    if (!active(o)) return;
    if (o.size - o.filled < 1e-6) this.finish(o, "filled", now, null);
    // our own cancel usually lands here first (the user channel beats the cancel's reply); else the venue cancelled it
    else if (u.type === "CANCELLATION" || /^CANCEL/i.test(u.status ?? "")) this.finish(o, "cancelled", now,
      `${o.status === "cancelling" && o.cancelDue != null ? `cancel confirmed by the venue in ${now - o.cancelDue} ms` : "cancelled by the venue"} · ${fmtFill(o)}${restWords(o, now)}`);
  }

  closeWindow(win: number, now: number): void {
    for (const o of this.orders.values()) if (o.win === win && active(o)) this.cancel(o, now, "market closed");
  }

  cancelAll(now: number, why: string): void {
    for (const o of this.orders.values()) if (active(o)) this.cancel(o, now, why);
  }

  unsynced(): boolean { return this.fills.length > 0 || this.acks.length > 0; }

  working(win?: number): Order[] {
    return [...this.orders.values()].filter((o) => active(o) && (win == null || o.win === win));
  }

  visible(win: number): Order[] {
    return [...this.orders.values()].filter((o) => o.win === win).sort((a, b) => a.id - b.id);
  }

  /** Venue ids of our orders still on the book (persisted, so a restart cancels exactly these). */
  openIds(): string[] {
    const out: string[] = [];
    // an order whose post is unanswered too, by its signed id (LIVE_EARLY_CANCEL): a cancel then refuses a late placement
    for (const o of this.orders.values()) { const m = this.meta.get(o.id), x = m?.xid ?? (this.earlyCancel ? m?.pre : null); if (x && active(o) && !o.take) out.push(x); }
    return out;
  }

  /** Our resting size on one token's book (bids) and, mirrored, on the other token's (asks at 1 − p). */
  own(asset: string): OwnLevels | null {
    let r: OwnLevels | null = null;
    for (const o of this.orders.values()) {
      if (!active(o) || o.liveAt == null || o.take) continue;
      const m = this.meta.get(o.id), rem = o.size - o.filled;
      if (!m || rem < 1e-6) continue;
      const mine = asset === m.tokenId, mirror = asset === m.otherId;
      if (!mine && !mirror) continue;
      r ??= { bids: new Map(), asks: new Map() };
      const side = mine ? r.bids : r.asks, k = priceKey(mine ? o.tokenPrice : 1 - o.tokenPrice);
      side.set(k, (side.get(k) ?? 0) + rem);
    }
    return r;
  }

  step(now: number, win: number, book: BookView, mark: { fv: number | null; mid: number | null }): Fill[] {
    for (const o of this.acks) {
      if (o.take) continue;
      if (o.liveAt == null) continue;
      const lvl = o.win === win && book.ready ? levelSize(book, o.side, o.price) : 0;
      o.queue = lvl; o.queue0 = lvl; o.lv = [[now, lvl]];
      this.emit({ t: o.liveAt, win: o.win, oid: o.id, type: "live", side: o.side, price: o.price, size: o.size,
        note: `on the book after ${o.liveAt - o.createdAt} ms · ${fmtSh(lvl)} sh of others at its price`, ...evTok(o) });
    }
    this.acks = [];
    // the queue ahead is the venue's; shown as the others' size at our level, never more than when we joined
    if (book.ready) {
      for (const o of this.orders.values()) {
        if (o.win !== win || !active(o) || o.liveAt == null || !o.lv.length) continue;
        const lvl = levelSize(book, o.side, o.price);
        o.lv.push([now, lvl]);
        if (o.lv.length > 50) o.lv.shift();
        if (o.queue > lvl) o.queue = lvl;
      }
    }
    const out: Fill[] = [];
    for (const f of this.fills) {
      const o = f.o, rest = f.t - (o.liveAt ?? f.t), cur = o.win === win;
      // our cancel was decided before the fill (cancelAt), or the venue cancelled it. Not the status alone: a fill that
      // completes the order has already set it "filled" by the time this runs (onUpdate finishes it right after the push)
      const cxl = o.cancelAt != null || o.status === "cancelled";
      if (o.take) {
        const tp = f.px ?? o.tokenPrice, fee = takerFee(tp) * f.size;
        out.push({
          id: this.nextFillId++, oid: o.id, win: o.win, t: f.t, side: o.side, price: o.token === "UP" ? tp : 1 - tp, token: o.token, tokenSide: o.tokenSide,
          tokenPrice: tp, size: f.size, via: "take", queue0: 0, restMs: 0, fv: cur ? mark.fv : null, mid: cur ? mark.mid : null,
          mk: [null, null, null], settle: null, inv: "", fee,
          note: `taken on Polymarket at ${cents(tp)} · fee $${fee.toFixed(3)} · ${f.t - o.createdAt} ms after it was sent`,
        });
        continue;
      }
      out.push({
        id: this.nextFillId++, oid: o.id, win: o.win, t: f.t, side: o.side, price: o.price, token: o.token, tokenSide: o.tokenSide,
        tokenPrice: o.tokenPrice, size: f.size, via: "live", queue0: o.queue0, restMs: rest, fv: cur ? mark.fv : null, mid: cur ? mark.mid : null,
        mk: [null, null, null], settle: null, inv: "", cxl, ...(cxl ? { cxlWhy: cancelKind(o.cancelWhy) } : {}),
        note: `${o.size - o.filled < 1e-6 ? "filled" : `partial, ${fmtSh(o.size - o.filled)} left`} on Polymarket · ${fmtSh(o.queue0)} were ahead · rested ${(rest / 1000).toFixed(1)} s` +
          (cxl ? " · cancel was in flight" : ""),
      });
    }
    this.fills = [];
    for (const o of this.orders.values()) {
      const m = this.meta.get(o.id);
      if (!m || !active(o)) continue;
      if (m.uncertain && !m.xid && now >= m.uncertain.until) {
        this.finish(o, "rejected", now, `post failed (${m.uncertain.why}); no such order appeared on the venue`);
        if (o.take) this.log(`[live] ⚠ take #${o.id} threw and no trade of it showed in ${ORPHAN_MS / 1000} s: if it filled after all, the wallet check stops the bot`);
        continue;
      }
      if (m.xid && !m.polling && now - m.heard >= POLL_MS) {
        m.polling = true;
        (o.take ? this.settleTake(o) : this.settle(o, "no event for 3 s", true)).then(() => { m.polling = false; m.heard = this.now(); }, () => { m.polling = false; m.heard = this.now(); });
      }
    }
    for (const [xid, e] of this.early) {
      if (now - e.at >= EARLY_KEEP_MS) { this.early.delete(xid); continue; }
      if (e.told || now - e.at < ORPHAN_MS) continue;
      e.told = true;
      const last = e.u[e.u.length - 1];
      this.log(`[live] venue order …${xid.slice(-8)} (${last.type}, ${last.sizeMatched}/${last.size ?? "?"} @ ${last.price ?? "?"}) is not this bot's: another bot or a manual order on the wallet, left alone`);
    }
    for (const [xid, e] of this.earlyT) {
      if (now - e.at >= EARLY_KEEP_MS) { this.earlyT.delete(xid); continue; }
      if (e.told || now - e.at < ORPHAN_MS) continue;
      e.told = true;
      this.log(`[live] taker trade of …${xid.slice(-8)} (${[...e.t.values()].reduce((a, x) => a + x.size, 0)} sh of …${e.tokenId.slice(-8)}) is not this bot's: another bot or a manual order on the wallet`);
    }
    for (const o of this.orders.values()) {
      const t = this.tm.get(o.id);
      if (!t || active(o) || o.doneAt == null || now - o.doneAt < TIMING_WAIT_MS) continue;
      this.tm.delete(o.id);
      const line = timingLine(o, t);
      this.emit({ t: now, win: o.win, oid: o.id, type: "info", side: o.side, price: o.price, size: o.size, note: line, ...evTok(o) });
      this.log(`[live] #${o.id} ${o.token === "UP" ? "Up" : "Down"} ${o.take ? "take ≤" : "bid @"} ${cents(o.tokenPrice)} ${line}`);
    }
    for (const o of this.orders.values()) {
      if (active(o) || o.doneAt == null) continue;
      if (now - o.doneAt > LINGER_MS) { this.orders.delete(o.id); this.tm.delete(o.id); }
    }
    for (const [xid, o] of this.byX) {
      if (!active(o) && o.doneAt != null && now - o.doneAt > KEEP_MS) { this.byX.delete(xid); this.meta.delete(o.id); }
    }
    return out;
  }

  private finish(o: Order, status: "filled" | "cancelled" | "rejected", now: number, note: string | null): void {
    o.status = status;
    o.doneAt = now;
    if (note != null) this.emit({ t: now, win: o.win, oid: o.id, type: status === "rejected" ? "reject" : "cancelled", side: o.side, price: o.price, size: o.size, note, ...evTok(o) });
    if (status === "rejected") this.meta.delete(o.id);
  }
}

function active(o: Order): boolean { return o.status === "pending" || o.status === "open" || o.status === "cancelling"; }
const evTok = (o: Order) => ({ token: o.token, tokenSide: o.tokenSide, tokenPrice: o.tokenPrice });
function fmtSh(x: number): string { return x >= 1000 ? (x / 1000).toFixed(1) + "k" : x >= 100 || x % 1 === 0 ? x.toFixed(0) : x.toFixed(1); }
function fmtFill(o: Order): string { return `${fmtSh(o.filled)}/${fmtSh(o.size)} filled`; }
function restWords(o: Order, now: number): string { return o.liveAt != null ? ` · rested ${((now - o.liveAt) / 1000).toFixed(1)} s` : " · never reached the book"; }
function cents(x: number): string { return `${(x * 100).toFixed(1)}¢`; }
/** "timing (…): sign 3 · placed v+180 h+195 · answer +1132 · match v+1240 h+1261 · cancel +1132→+1199 · filled 5/5", in ms
 *  after the order was sent. v≈ marks a venue time in whole seconds (it can't place the event within its second). */
function timingLine(o: Order, t: Timing): string {
  const rel = (x: number | null | undefined) => (x == null ? "?" : `${x >= o.createdAt ? "+" : "−"}${Math.abs(Math.round(x - o.createdAt))}`);
  const ev = (e: { ts?: number; rx: number }) => (e.ts != null ? `v${e.ts % 1000 === 0 ? "≈" : ""}${rel(e.ts)} ` : "") + `h${rel(e.rx)}`;
  const parts = [`sign ${t.sign ?? "?"}`];
  if (!o.take) parts.push(`placed ${t.placed ? ev(t.placed) : "—"}`);
  parts.push(`answer ${rel(t.answer)}`);
  if (t.match) parts.push(`match ${ev(t.match)}${/^(UPDATE|MATCHED)$/.test(t.match.via) ? "" : ` (${t.match.via.toLowerCase()})`}`);
  if (t.cxlSent != null) parts.push(`cancel ${rel(t.cxlSent)}→${rel(t.cxlAns)}${t.cxlEarly ? " (by the signed id)" : ""}`);
  if (t.race) parts.push(`copies ${t.race.n}: ${[...t.race.got].sort((a, b) => a.at - b.at).map((g) => `${g.what} ${rel(g.at)}`).join(", ")}`);
  return `timing (ms after send; v = venue clock, h = heard here): ${parts.join(" · ")} · ${o.status === "filled" ? "filled" : `${o.status}, ${fmtFill(o)}`}`;
}
function push(a: number[], v: number): void { a.push(v); if (a.length > 200) a.shift(); }
export const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
