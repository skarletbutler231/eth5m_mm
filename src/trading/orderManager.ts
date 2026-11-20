// ORDER MANAGER — keeps at most one working order a side in line with the quoter's target, every frame.
// The quoter thinks in Up-book terms (bid / ask). Both sides go out as BUYS: the bid as an Up bid at p,
// the ask as a Down bid at 1 − p (the same liquidity on the mirrored book). Up and Down fills pair up and
// merge for $1, so the bot never needs to hold a token to quote the other side.
//
//   no target      cancel the working order (pull, gate, limit)                       → cancel
//   no order       place the target, cut to what the free balance covers             → place
//   same price     keep it: its queue spot is the asset                              → keep
//   tolerated      working price at most MM_TOLERATE_TICKS more aggressive than the
//                  target and still MM_TOLERATE_EDGE inside the reservation          → keep
//   riskier        working price is MORE aggressive than that (a bid above the target,
//                  an ask below it) or its size is over the target: replace at once  → replace
//   at the touch   working price only LESS aggressive, but already the best price of
//                  its book (MM_STAY_AT_TOUCH): moving up only leaves the queue       → keep
//   safer          working price only LESS aggressive and behind the touch: keep it
//                  MM_REQUOTE_MIN_MS for its queue spot, then chase                   → hold, then replace
// Why the tolerance (2026-10-10, 9,559 orders): orders lived a median 1.0 s and 58% of the unfilled ones were
// cancelled to re-price, mostly by a tick, so none reached the front of a ~300-share queue. Queue fills mark
// out at +0.7¢ (1 s), cross fills at −2.1¢. The pull rule (2 s FV move) still cancels on real moves.
// A replace is cancel + place sent together; the old order can still fill while its cancel is in flight.
// Balance: as on Polymarket, every working bid reserves its cost (Up p·size, Down q·size) until it fills or
// its cancel lands, so after a replace the old and new orders both count against the free USDC.
//
// QUEUE RACE (ctx.race; v4). A bid that joined an existing level is cancelled when
//   · that level (the others at its price) falls below MM_RACE_LEVEL (50%) of its size when the bid went live, or
//   · its side's share of the touch, level / (level + the opposite best), falls below MM_RACE_SHARE (0.2).
// No new bid joins an existing level whose share is under MM_RACE_SHARE, and after a race cancel that side does not
// rejoin the same price for MM_RACE_HOLD_MS. A bid alone at its level (it made the level) is left to the quoter.
// MM_RACE_ON_BOOK=on: the two exits also run on every update of the Up book (raceOnly, from engine.raceOnBook), between
// the decisions on the 10 ms timer; that path only cancels (and sets the hold), the next decision re-quotes.
// Why (2026-10-11, 4,669 recorded windows, hypothetical 50-share bids replayed FIFO on the tape): a resting bid loses
// at every queue position, because its worst fills come when the level empties and the price goes through
// ("cleared": 38% of the front's filled shares, 82% of the back's, at about −2.5¢). With this rule, settlement plus
// rebate per filled share went from −1.2¢ to −0.05¢ at the front of the queue and from −2.5¢ to −1.6¢ at the back,
// where every new bid starts.
//
// OUTBID (ctx.race.outbid; v4, MM_RACE_OUTBID). A bid that has been the best price of its book while live and is now
// behind it (someone bid higher) is cancelled at once, and replaced at the quoter's target if that is a new price; it
// does not rejoin the price it left for MM_RACE_HOLD_MS. A bid that went live behind the touch on the quoter's say-so
// is left alone until it has been the touch. Why (2026-10-11, the same replay, joins at the back): the race rules alone
// −2.3¢ per filled share (pro-rata cancels −1.5¢), with this rule too −0.8¢; once outbid the bid sits one tick behind
// the touch, where it fills only when the level ahead is swept (−2.2¢ even with both rules). OFF by default: on paper
// (18:05–19:05 UTC 2026-10-11, 11 windows) maker fills settled −1.62¢ a share against −1.42¢ without it, and the
// pair cost rose.
import type { BookView } from "../feeds/pmBook.js";
import type { Quote } from "../quoter.js";
import type { Exchange } from "./exchange.js";
import { levelSize } from "./paperExchange.js";
import { cents, EPS, r4, type Order, type Side } from "./types.js";

export type Act = "keep" | "place" | "replace" | "cancel" | "hold" | "idle" | "skip" | "take";
/** side: which token's bid this row is about ("pair": the pair trade's state, pairTrader.ts). */
export interface Action { side: "up" | "down" | "pair"; act: Act; note: string }

/** USDC a working order locks: a BUY its cost at its own token price (a SELL locks tokens, not USDC). */
export function reserveOf(tokenSide: Side, tokenPrice: number, size: number): number {
  return tokenSide === "BUY" ? tokenPrice * size : 0;
}

const lbl = (o: Order) => `${o.token === "UP" ? "Up" : "Down"} ${cents(o.tokenPrice)}`;

/** Queue retention: off by default (replace at once, chase after the hold). */
export interface Tolerance { ticks: number; edge: number; stayAtTouch: boolean }
const NO_TOLERANCE: Tolerance = { ticks: 0, edge: 0, stayAtTouch: false };

/** Queue race: level / share thresholds (null = that rule off), the outbid rule, the rejoin hold after a race cancel and
 *  whether the level / share rules also run while a joining bid's post is unanswered (MM_RACE_INFLIGHT). */
export interface RaceCfg {
  level: number | null; share: number | null; holdMs: number; outbid?: boolean; inflight?: boolean;
  /** Depth cap: no joining a level holding ≥ joinMax shares (MM_JOIN_MAX_SH), or ≥ joinRel × the median best-level size
   *  on that side over the last joinRefMs (MM_JOIN_MAX_REL, MM_JOIN_REF_MS). null / unset = that cap off. */
  joinMax?: number | null; joinRel?: number | null; joinRefMs?: number;
}

export interface SyncCtx {
  free: number; minSize: number; tick?: number;
  /** The Up book's best bid / ask (Up terms), for the at-the-touch rule. */
  bestBid?: number | null; bestAsk?: number | null;
  /** The Up book and the queue-race settings (null = no race rules). */
  book?: BookView | null; race?: RaceCfg | null;
  /** MM_CAP_PENDING: net Up shares now and the cap; a new bid fits under the cap with every order on its side that can
   *  still fill (null = the quoter's cut by the filled net alone). */
  cap?: { net: number; max: number } | null;
}

/** A price's level (the others at it) and its side's share of the touch, level / (level + the opposite best). */
function raceOf(bk: BookView, side: Side, price: number): { lvl: number; share: number } {
  const lvl = levelSize(bk, side, price);
  const opp = (side === "BUY" ? bk.asks[0]?.[1] : bk.bids[0]?.[1]) ?? 0;
  return { lvl, share: lvl + opp > 0 ? lvl / (lvl + opp) : 0 };
}

export class OrderManager {
  /** Race holds: `${win}:${side}` → no rejoin at that Up-terms price until `until`. */
  private holds = new Map<string, { price: number; until: number }>();
  /** Ids of working bids that have been the best price of their book while live (the outbid rule). */
  private touched = new Set<number>();
  /** MM_RACE_INFLIGHT: the others' size at each posted bid's price when it was posted (0 = it made its own level). */
  private joinLvl = new Map<number, number>();
  /** MM_JOIN_MAX_REL: the window's best bid / ask sizes (Up terms), one sample at each change of the top of the book. */
  private tops: { win: number; t: number[]; bid: number[]; ask: number[] } = { win: -1, t: [], bid: [], ask: [] };
  /** The last sync's pair-cost "rest" flag per side (a bid resting at the cap price is outside the race): raceOnly uses it. */
  private rest: Record<Side, boolean> = { BUY: false, SELL: false };

  constructor(private readonly ex: Exchange, private readonly requoteMinMs: number, private readonly tol: Tolerance = NO_TOLERANCE) {}

  /** The race exits' verdict on a working bid (null = it stays): it joined an existing level (queue0 > 0) and that level
   *  thinned under MM_RACE_LEVEL of its size then, or its side's share of the touch fell under MM_RACE_SHARE. */
  private raceWhy(bk: BookView, side: Side, w: Order, rc: RaceCfg): string | null {
    if (w.liveAt == null || !(w.queue0 > EPS)) return null;
    const r = raceOf(bk, side, w.price);
    return rc.level != null && r.lvl < rc.level * w.queue0 - EPS
      ? `race: the level fell to ${fmt(r.lvl)} sh, under ${Math.round(rc.level * 100)}% of the ${fmt(w.queue0)} when it went live`
      : rc.share != null && r.share < rc.share - EPS
      ? `race: its side holds ${r.share.toFixed(2)} of the touch, under ${rc.share}` : null;
  }

  /** A race cancel: the order goes, and that side does not rejoin its price for MM_RACE_HOLD_MS. */
  private raceCancel(win: number, side: Side, w: Order, now: number, why: string, rc: RaceCfg): void {
    this.ex.cancel(w, now, why);
    this.holds.set(`${win}:${side}`, { price: w.price, until: now + rc.holdMs });
  }

  /** Whether the window has a bid the race exits watch (live, joined an existing level, not being cancelled): lets the
   *  book-update path skip building a book view when there is nothing to check. */
  raceable(win: number): boolean {
    for (const o of this.ex.working(win)) if (!o.take && o.status !== "cancelling" && o.liveAt != null && o.queue0 > EPS && !this.rest[o.side]) return true;
    return false;
  }

  /** MM_RACE_ON_BOOK: the race exits alone, on a book update between decisions (engine.raceOnBook). Only cancels (and
   *  sets the rejoin hold, as sync's race cancel does); it never places or re-prices: the next decision does that. The
   *  in-flight rule (MM_RACE_INFLIGHT) stays on the decisions. */
  raceOnly(win: number, now: number, book: BookView, rc: RaceCfg): Action[] {
    const out: Action[] = [];
    if (!book.ready) return out;
    for (const side of ["BUY", "SELL"] as const) {
      if (this.rest[side]) continue;
      const w = this.ex.working(win).find((o) => o.side === side && o.status !== "cancelling" && !o.take);
      const why = w ? this.raceWhy(book, side, w, rc) : null;
      if (!w || !why) continue;
      this.raceCancel(win, side, w, now, `${why} · on a book update`, rc);
      out.push({ side: side === "BUY" ? "up" : "down", act: "cancel", note: `#${w.id} ${lbl(w)} · ${why} · on a book update` });
    }
    return out;
  }

  /** The median best-level size on a side (BUY = Up bids, SELL = Up asks = Down bids) over the last ms; null = no samples. */
  private topMedian(side: "BUY" | "SELL", now: number, ms: number): number | null {
    const T = this.tops, v: number[] = [], src = side === "BUY" ? T.bid : T.ask;
    for (let i = T.t.length - 1; i >= 0 && T.t[i] >= now - ms; i--) v.push(src[i]);
    if (!v.length) return null;
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  }

  private sampleTop(win: number, now: number, bk: BookView, ms: number): void {
    const T = this.tops;
    if (T.win !== win) { T.win = win; T.t = []; T.bid = []; T.ask = []; }
    const b = bk.bids[0]?.[1] ?? 0, a = bk.asks[0]?.[1] ?? 0, n = T.t.length;
    if (n && T.bid[n - 1] === b && T.ask[n - 1] === a) return;
    T.t.push(now); T.bid.push(b); T.ask.push(a);
    if (T.t.length > 512 && T.t[0] < now - ms) {
      const k = T.t.findIndex((t) => t >= now - ms);
      const cut = k < 0 ? T.t.length : k;
      T.t.splice(0, cut); T.bid.splice(0, cut); T.ask.splice(0, cut);
    }
  }

  sync(win: number, q: Quote, now: number, ctx: SyncCtx): Action[] {
    const out: Action[] = [];
    if (ctx.race?.joinRel != null && ctx.book?.ready) this.sampleTop(win, now, ctx.book, ctx.race.joinRefMs ?? 30_000);
    if (this.holds.size > 4) for (const k of [...this.holds.keys()]) if (!k.startsWith(`${win}:`)) this.holds.delete(k);
    if (this.touched.size > 16) {
      const ids = new Set(this.ex.working(win).map((o) => o.id));
      for (const id of this.touched) if (!ids.has(id)) this.touched.delete(id);
    }
    if (this.joinLvl.size > 32) {
      const ids = new Set(this.ex.working(win).map((o) => o.id));
      for (const id of this.joinLvl.keys()) if (!ids.has(id)) this.joinLvl.delete(id);
    }
    let free = ctx.free;
    for (const side of ["BUY", "SELL"] as const) {
      const key = side === "BUY" ? "up" : "down";
      const px = side === "BUY" ? q.bid : q.ask;                     // Up terms
      const token = side === "BUY" ? "UP" : "DOWN";
      const tpx = px == null ? null : side === "BUY" ? px : r4(1 - px);   // what one share costs us
      const sz = side === "BUY" ? q.bidSize : q.askSize;
      // taker orders (v4) are the trader's, not this side's working maker order
      const live = this.ex.working(win).filter((o) => o.side === side && o.status !== "cancelling" && !o.take);
      for (const extra of live.slice(1)) this.ex.cancel(extra, now, "duplicate on this side");
      const w: Order | undefined = live[0];

      // ---- queue race: a bid that joined an existing level leaves when it is losing the race for that level ----
      const rc = ctx.race ?? null, bk = ctx.book?.ready ? ctx.book : null;
      const race = (price: number) => raceOf(bk!, side, price);
      const hk = `${win}:${side}`;
      // MM_PC_RACE=off: a bid the pair-cost cap holds back rests at the cap price, outside the race
      const rest = side === "BUY" ? q.pcLim?.rest.bid === true : q.pcLim?.rest.ask === true;
      this.rest[side] = rest;
      // MM_RACE_INFLIGHT: the same two rules while the post is unanswered, against the level seen when it was posted; a bid
      // posted to an empty level stays exempt (as w.queue0 = 0 once live). The cancel goes by the signed id (early cancel).
      const j = rc?.inflight && bk && w && w.liveAt == null && !rest ? this.joinLvl.get(w.id) : undefined;
      if (j != null && j > EPS) {
        const r = race(w!.price);
        const why = rc!.level != null && r.lvl < rc!.level * j - EPS
          ? `race: in flight, the level fell to ${fmt(r.lvl)} sh, under ${Math.round(rc!.level * 100)}% of the ${fmt(j)} when it was posted`
          : rc!.share != null && r.share < rc!.share - EPS
          ? `race: in flight, its side holds ${r.share.toFixed(2)} of the touch, under ${rc!.share}` : null;
        if (why) {
          this.ex.cancel(w!, now, why);
          this.holds.set(hk, { price: w!.price, until: now + rc!.holdMs });
          out.push({ side: key, act: "cancel", note: `#${w!.id} ${lbl(w!)} · ${why}` });
          continue;
        }
      }
      if (rc && bk && w && !rest) {
        const why = this.raceWhy(bk, side, w, rc);
        if (why) {
          this.raceCancel(win, side, w, now, why, rc);
          out.push({ side: key, act: "cancel", note: `#${w.id} ${lbl(w)} · ${why}` });
          continue;
        }
      }
      /** Why a new bid at this Up-terms price must not go in (null = it may). */
      const gate = (price: number): string | null => {
        if (!rc || !bk || rest) return null;
        const h = this.holds.get(hk);
        if (h && now < h.until && Math.abs(h.price - price) < EPS) return `race hold: a race cancel left ${cents(side === "BUY" ? price : r4(1 - price))}; rejoins in ${h.until - now} ms`;
        const r = race(price);
        if (rc.share != null && r.lvl > EPS && r.share < rc.share - EPS) return `race: that level holds ${r.share.toFixed(2)} of the touch, under ${rc.share}`;
        // MM_JOIN_MAX_SH: no joining behind a deep queue
        if (rc.joinMax != null && r.lvl > EPS && r.lvl >= rc.joinMax - EPS) return `depth: that level holds ${fmt(r.lvl)} sh, at or over the ${fmt(rc.joinMax)} cap`;
        if (rc.joinRel != null && r.lvl > EPS) {
          const ms = rc.joinRefMs ?? 30_000, ref = this.topMedian(side, now, ms);
          if (ref != null && r.lvl >= rc.joinRel * Math.max(ref, 1) - EPS)
            return `depth: that level holds ${fmt(r.lvl)} sh, at or over ${rc.joinRel} × the ${fmt(ref)} sh median best size of the last ${ms / 1000} s`;
        }
        return null;
      };

      const place = (reason: string): { o: Order | null; note: string } => {
        let s = Math.min(sz, Math.floor(Math.max(0, free) / tpx! + EPS));
        if (s < ctx.minSize) return { o: null, note: `free $${free.toFixed(2)} covers only ${Math.max(0, s)} sh at ${cents(tpx!)} (min ${ctx.minSize})` };
        let cut = s < sz ? "balance" : "";
        if (ctx.cap) {
          // a replaced bid is still working until its cancel lands, and a sweep fills it and the new one together. Live,
          // the venue's cancel answer ends that; the paper exchange says when it would have (Order.offAt)
          let pend = 0;
          for (const o of this.ex.working(win)) if (o.side === side && (o.offAt == null || now < o.offAt)) pend += o.size - o.filled;
          const room = (side === "BUY" ? ctx.cap.max - ctx.cap.net : ctx.cap.max + ctx.cap.net) - pend;
          const c = Math.floor(room + EPS);
          if (c < s) {
            if (c < ctx.minSize) return { o: null, note: `cap: ${fmt(pend)} sh still working on this side leave ${fmt(Math.max(0, room))} under ±${ctx.cap.max} (min ${ctx.minSize})` };
            s = c; cut = `the cap (${fmt(pend)} sh still working)`;
          }
        }
        free -= reserveOf("BUY", tpx!, s);
        const o = this.ex.place({ win, token, side: "BUY", price: tpx!, size: s, reason: cut ? `${reason} · cut from ${sz} by ${cut}` : reason }, now);
        if (rc?.inflight && bk && !rest) this.joinLvl.set(o.id, race(px!).lvl);
        return { o, note: `#${o.id} ${s} @ ${lbl(o)}` };
      };

      // ---- outbid: a bid that has been the touch and is now behind it leaves, and goes to the target if that moved ----
      if (rc?.outbid && bk && w && w.liveAt != null) {
        const top = (side === "BUY" ? bk.bids[0]?.[0] : bk.asks[0]?.[0]) ?? null;   // the best price on its side, Up terms
        if (top == null || (side === "BUY" ? w.price >= top - EPS : w.price <= top + EPS)) this.touched.add(w.id);
        else if (this.touched.has(w.id)) {
          const why = `outbid: the best ${key === "up" ? "Up" : "Down"} bid went to ${cents(side === "BUY" ? top : r4(1 - top))}`;
          this.ex.cancel(w, now, why);
          this.touched.delete(w.id);
          this.holds.set(hk, { price: w.price, until: now + rc.holdMs });
          const g = px == null || sz <= 0 ? (side === "BUY" ? q.off.bid : q.off.ask) ?? "no target" : gate(px);
          if (g) { out.push({ side: key, act: "cancel", note: `#${w.id} ${lbl(w)} · ${why} · ${g}` }); continue; }
          const r = place(`replaces #${w.id}: ${why}`);
          out.push({ side: key, act: "replace", note: `#${w.id} → ${r.o ? r.note : `nothing (${r.note})`} · ${why}` });
          continue;
        }
      }

      if (px == null || sz <= 0) {
        const why = (side === "BUY" ? q.off.bid : q.off.ask) ?? "no target";
        if (w) { this.ex.cancel(w, now, why); out.push({ side: key, act: "cancel", note: `#${w.id} ${lbl(w)} · ${why}` }); }
        else out.push({ side: key, act: "idle", note: why });
        continue;
      }

      if (!w) {
        const g = gate(px);
        if (g) { out.push({ side: key, act: "idle", note: g }); continue; }
        const r = place(`new ${token === "UP" ? "Up" : "Down"} bid: target ${sz} @ ${cents(tpx!)}`);
        out.push(r.o ? { side: key, act: "place", note: r.note } : { side: key, act: "skip", note: r.note });
        continue;
      }

      const rem = w.size - w.filled;
      const samePx = Math.abs(w.price - px) < EPS;
      const riskier = side === "BUY" ? w.price > px + EPS : w.price < px - EPS;
      const oversize = rem > sz + EPS;
      if (samePx && !oversize) {
        out.push({ side: key, act: "keep", note: w.liveAt == null ? `#${w.id} in flight` : `#${w.id} ${fmt(rem)} @ ${lbl(w)} · ${fmt(w.queue)} ahead (joined behind ${fmt(w.queue0)})` });
        continue;
      }
      if (!oversize && w.liveAt != null) {
        // a tick or so over the target but still inside the reservation: the queue spot is worth more
        const over = side === "BUY" ? w.price - px : px - w.price;
        const room = q.reservation == null ? null : side === "BUY" ? q.reservation - w.price : w.price - q.reservation;
        // the pair-cost cap is hard: a working order past it is never tolerated
        const lim = side === "BUY" ? q.pcLim?.bid ?? null : q.pcLim?.ask ?? null;
        const pastCap = lim != null && (side === "BUY" ? w.price > lim + EPS : w.price < lim - EPS);
        if (riskier && !pastCap && this.tol.ticks > 0 && over <= this.tol.ticks * (ctx.tick ?? 0.01) + EPS && room != null && room >= this.tol.edge - EPS) {
          out.push({ side: key, act: "keep", note: `#${w.id} ${lbl(w)} stays ${cents(over)} over the ${cents(tpx!)} target, ${(room * 100).toFixed(2)}¢ inside the reservation · ${fmt(w.queue)} ahead` });
          continue;
        }
        // already the best price of its book: chasing a better target would only leave the queue
        const top = side === "BUY" ? ctx.bestBid : ctx.bestAsk;
        if (!riskier && this.tol.stayAtTouch && top != null && (side === "BUY" ? w.price >= top - EPS : w.price <= top + EPS)) {
          out.push({ side: key, act: "keep", note: `#${w.id} ${lbl(w)} at the best ${key === "up" ? "Up" : "Down"} bid: keeps its queue spot instead of chasing ${cents(tpx!)} · ${fmt(w.queue)} ahead` });
          continue;
        }
      }
      const age = now - (w.liveAt ?? w.createdAt);
      if (riskier || oversize || age >= this.requoteMinMs) {
        const why = riskier ? `target ${cents(tpx!)}: working ${lbl(w)} is now too high`
          : oversize ? `size ${fmt(rem)} over target ${sz}`
          : `target moved up to ${cents(tpx!)}`;
        const g = gate(px);
        if (g) {
          // the new price is losing the race: a risky order still goes, a safer one stays where it is
          if (riskier || oversize) { this.ex.cancel(w, now, `${why}; no replacement (${g})`); out.push({ side: key, act: "cancel", note: `#${w.id} · ${why} · ${g}` }); }
          else out.push({ side: key, act: "hold", note: `#${w.id} stays @ ${lbl(w)}: ${g}` });
          continue;
        }
        this.ex.cancel(w, now, `replace: ${why}`);
        const r = place(`replaces #${w.id}: ${why}`);
        out.push({ side: key, act: "replace", note: `#${w.id} → ${r.o ? r.note : `nothing (${r.note})`} · ${why}` });
      } else {
        out.push({ side: key, act: "hold", note: `#${w.id} stays @ ${lbl(w)} for its queue spot; chases ${cents(tpx!)} in ${this.requoteMinMs - age} ms` });
      }
    }
    return out;
  }
}

const fmt = (x: number) => (x >= 1000 ? (x / 1000).toFixed(1) + "k" : x >= 100 || x % 1 === 0 ? x.toFixed(0) : x.toFixed(1));
