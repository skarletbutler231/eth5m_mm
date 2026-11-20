// PAIR TRADE (PAIR_TRADE=on) — instead of making a market, the bot trades the move signal (signal.ts) in Up+Down pairs.
//   signal a target move of at least PAIR_MIN_MOVE in PAIR_LOOKBACK_MS that leads the book, on the flow forecast's
//          side. PAIR_LEAD=unmoved (default): the book mid did not move. PAIR_LEAD=excess: it was still or moved the
//          target's way, and the target moved at least PAIR_MIN_MOVE more than it. PAIR_MOVE=free measures the move on
//          the target's sides the post-only rule did not hold (both = their average, default).
//   leg 1  PAIR_LEG1=maker (default): a post-only bid on the token it points to, at that token's best bid, cancelled
//          PAIR_MAKER_MS later; no taker fallback. PAIR_LEG1=taker: a fill-and-kill buy at most PAIR_SLIP over its ask.
//          Live, the taker filled 11% and lost 2.3¢ a pair: it waits 150 ms at the venue, and faster takers empty the ask
//          first; a wider limit fills more but each step loses more (+3¢ 29% −0.8¢, +5¢ 57% −1.0¢, on the live orders).
//          A maker bid joins the queue the takers of the other side reach (a bid on Up at b is the Down ask at 1 − b).
//   leg 2  PAIR_HOLD_MS after leg 1 filled, buy as many of the other token as a taker (walking up to PAIR_CLOSE_SLIP over
//          its ask), again until all are bought. With PAIR_CLOSE_EDGE it goes sooner, once the pair would lock that much a
//          pair at the other token's ask after both fees; with PAIR_STOP_MOVE, once the Up mid has moved that far against
//          leg 1 within PAIR_STOP_MS of its fill. Up + Down pays $1 whatever the label and merges at once, so the
//          pair locks what the move paid: the other token got cheaper by about what leg 1's gained. Forced
//          PAIR_CLOSE_LEFT_SEC before the close; what is still unpaired at the close waits for the label. With PAIR_L2_MODEL,
//          the leg-2 model (model/legTwo.ts) scores each fill: P(the Up mid moves against leg 1 in the next 5 s); at
//          PAIR_L2_MODEL_P or over, in a window it is armed for, leg 2 goes at once.
//   gates  one pair at a time; leg 1 up to PAIR_UNTIL_SEC into the window, on a token asking 5¢ to PAIR_MAX_PRICE; sized
//          PAIR_SIZE, cut by the free balance. A fill under the market's minimum order size is held, not paired: the venue
//          refuses a leg 2 that small.
//   sizing both legs are market BUYs of a USDC amount, as the venue runs them (a better price buys more shares, the whole
//          amount is spent: tools/take-test.ts, 2026-10-14): leg 1 spends PAIR_SIZE × its limit, so a full fill is at least
//          PAIR_SIZE shares; leg 2 spends the shares to pair × the other token's ask, so it buys about that many. Never
//          under $1, the venue's minimum for a marketable BUY.
// The detector is the pair's own (signal.ts at PAIR_MIN_MOVE in PAIR_LOOKBACK_MS, lead-only), so the /signal feed's
// settings, and its per-direction cooldown after smaller moves, do not change what it trades. PAIR_SIGNAL=fast trades the
// /signal-fast feed's detector instead (FAST_SIGNAL_*: the same, 5¢ in 100 ms), whose signals the engine hands to open().
// Every signal the detector it trades fires goes out on WS /signal-pair as well (engine.ts), once leg 1 is with the trader.
//
// Why (2026-10-14, README "Pair trade"; 144 archived windows of 100 ms frames, both fees): a taker leg 2 two seconds on made
// +4.6¢ a pair on 5¢ signals (2.3 a window, 71% of the pairs won), +2.8¢ on 4¢, and 3¢ lost however leg 2 was taken. A maker
// leg 1 rarely filled and lost 3-9¢ a pair when it did (it fills when the signal is wrong); a maker take-profit leg 2 capped
// the winners and did worse than a plain taker leg 2.
import { CFG } from "./config.js";
import { MoveSignal, type LeadMode, type MoveMeasure, type MoveMsg, type SigSample, type SignalCfg } from "./signal.js";
import type { BookView } from "./feeds/pmBook.js";
import type { Trader } from "./trading/trader.js";
import type { Action } from "./trading/orderManager.js";
import { takerFee } from "./trading/paperExchange.js";
import { LegTwoModel, l2Features } from "./model/legTwo.js";
import { cents, r4, type Order, type Token } from "./trading/types.js";

export type PairCfg = typeof CFG.pair;

/** A leg-2 try that came back short is sent again after this long. */
const RETRY_MS = 100;
const MIN_PX = 0.05;
/** The venue's minimum for a marketable BUY, USDC. */
const MIN_USD = 1;
/** USDC to whole cents, up: the venue signs a market BUY's amount in cents. */
const toCents = (x: number) => Math.ceil(x * 100 - 1e-6) / 100;

/** One pair, as archived with its window. Prices are the token's own. */
export interface PairRec {
  id: number; win: number;
  /** The signal: its seq in the pair's detector, time, direction and target move. */
  seq: number; t: number; dir: "up" | "down"; move: number;
  /** Leg 1's token, its ask at the signal, the limit sent (a maker leg's bid) and the size asked. */
  token: Token; ask0: number; limit: number; size: number;
  /** How leg 1 went out (absent: taker, before 2026-10-14 21:00). */
  kind?: "maker" | "taker";
  /** The detector that opened it (absent: own, before 2026-10-15 19:30 UTC) and its lookback. */
  signal?: "own" | "fast"; lookbackMs?: number;
  leg1: { qty: number; px: number | null; fee: number; at: number | null };
  /** by: what sent leg 2, the edge (PAIR_CLOSE_EDGE), the stop (PAIR_STOP_MOVE), the leg-2 model (PAIR_L2_MODEL) or the
   *  hold running out; edge: the pair's edge it saw then, after both fees at the other token's ask (absent: before
   *  PAIR_CLOSE_EDGE, 2026-10-16). */
  leg2: { qty: number; px: number | null; fee: number; at: number | null; tries: number; by?: "edge" | "hold" | "stop" | "model"; edge?: number | null };
  /** The leg-2 model at leg 1's fill: p = P(against in 5 s) (null: no input), armed = it may act in this window, fired =
   *  it sent leg 2 at once (absent: PAIR_L2_MODEL off, or before 2026-10-18). */
  l2?: { p: number | null; armed: boolean; fired: boolean };
  /** USDC on the paired shares: $1 each, less both legs and their fees (null while open or if nothing paired). */
  pnl: number | null;
  /** paired · missed (leg 1 found nothing within its limit) · held (shares left unpaired: the close, or under the minimum size). */
  end: "paired" | "missed" | "held" | null;
  note: string;
}

/** cancelAt: a maker leg 1 is cancelled then (null: a taker, or the cancel is sent). */
/** stopMid / stopUntil: the Up mid at leg 1's fill and the end of PAIR_STOP_MS (null: no stop). */
/** l2Go: the leg-2 model sends leg 2 at the next step. */
interface Live { rec: PairRec; entry: Order; exits: Order[]; closeAt: number | null; nextTry: number; cancelAt: number | null; stopMid: number | null; stopUntil: number | null; l2Go: boolean }

/** What the engine knows of the window at a quote. `book` is the Up book; rows / cols / Kcl: the window's 100 ms rows
 *  (engine.ts COLS) and strike, which the leg-2 model reads. */
export interface PairCtx {
  win: number; endTs: number; elapsed: number; left: number; minSize: number; tick: number; book: BookView;
  rows: readonly (readonly (number | null)[])[]; cols: readonly string[]; Kcl: number | null;
}

const working = (o: Order) => o.status === "pending" || o.status === "open" || o.status === "cancelling";
const tokName = (t: Token) => (t === "UP" ? "Up" : "Down");
const r6 = (x: number | null) => (x == null ? null : Math.round(x * 1e6) / 1e6);
const usd = (x: number) => (x >= 0 ? "+$" : "−$") + Math.abs(x).toFixed(2);
/** The other token's best ask, on the Up book (null: no book or no price). */
function otherAsk(b: BookView, other: Token): number | null {
  return !b.ready ? null : other === "UP" ? b.bestAsk : b.bestBid != null ? r4(1 - b.bestBid) : null;
}
/** What a pair locks, a pair, if leg 2 buys at ask2: $1 less leg 1's price and fee a share, less ask2 and its fee. */
const edgeAt = (r: PairRec, ask2: number) => 1 - r.leg1.px! - r.leg1.fee / r.leg1.qty - ask2 - takerFee(ask2);
/** The Up book's mid (null: no book or a side missing). */
const upMid = (b: BookView) => (b.ready && b.bestBid != null && b.bestAsk != null ? r4((b.bestBid + b.bestAsk) / 2) : null);
/** Shares resting at a token's bid price p, on the Up book: an Up bid on the Up bids, a Down bid at p on the Up asks at 1 − p. */
function queueAt(b: BookView, token: Token, p: number): number {
  const lv = token === "UP" ? b.bids : b.asks, q = token === "UP" ? p : 1 - p;
  for (const [px, sz] of lv) if (Math.abs(px - q) < 1e-6) return sz;
  return 0;
}

export class PairTrader {
  /** The pair's own detector (null with PAIR_SIGNAL=fast: the engine's /signal-fast detector hands its signals to open()). */
  readonly sig: MoveSignal | null;
  /** The settings of the detector it trades. */
  private readonly det: SignalCfg & { leadMode?: LeadMode; measure?: MoveMeasure };
  private cur: Live | null = null;
  private recs = new Map<number, PairRec[]>();
  private nextId = 1;
  /** Why the last signal did not open a pair, for the dashboard. */
  private skipped: string | null = null;
  /** The leg-2 model (null: PAIR_L2_MODEL off). */
  readonly l2: LegTwoModel | null;

  constructor(private readonly trader: Trader, readonly cfg: PairCfg, private readonly log: (m: string) => void) {
    this.det = cfg.signal === "fast" ? CFG.fastSignal
      : { ...CFG.signal, minMove: cfg.minMove, lookbackMs: cfg.lookbackMs, leadOnly: true, leadMode: cfg.lead, measure: cfg.move, minPred: null, top: null };
    this.sig = cfg.signal === "fast" ? null : new MoveSignal(this.det, "pair");
    this.l2 = cfg.l2Model === "off" ? null : LegTwoModel.load(cfg.l2ModelFile);
  }

  /** May the leg-2 model act in this window? on: always; ab: even 5-minute slots only. */
  l2Armed(win: number): boolean { return this.cfg.l2Model === "on" || (this.cfg.l2Model === "ab" && Math.floor(win / 300) % 2 === 0); }

  /** What it trades, for the logs and the dashboard. */
  signalDesc(): string {
    const d = this.det, mv = d.minMove == null ? "no" : `≥ ${cents(d.minMove)}`;
    return `${mv} target moves${d.measure === "free" ? " (free side)" : ""} in ${d.lookbackMs} ms that lead the book (${this.cfg.signal === "fast" ? "/signal-fast" : "own detector"})`;
  }

  /** Every quote the engine makes (frame or decide step), as it is made: a signal of its own detector sends leg 1 at once. */
  sample(s: SigSample, c: PairCtx, now: number): MoveMsg | null {
    const m = this.sig?.sample(s) ?? null;
    if (m) this.open(m, c, now);
    return m;
  }

  /** A signal: leg 1 at once, unless a gate says no. */
  open(m: MoveMsg, c: PairCtx, now: number): void {
    const token: Token = m.dir === "up" ? "UP" : "DOWN", maker = this.cfg.leg1 === "maker";
    const ask = token === "UP" ? m.book.ask : m.book.bid != null ? r4(1 - m.book.bid) : null;
    const bid = token === "UP" ? m.book.bid : m.book.ask != null ? r4(1 - m.book.ask) : null;
    const px = maker ? bid : ask, pxWord = maker ? "bids" : "asks";
    const why = this.cur ? `pair #${this.cur.rec.id} still open`
      : m.win !== c.win ? "another window"
      : c.elapsed > this.cfg.untilSec ? `${Math.round(c.elapsed)} s into the window, after ${this.cfg.untilSec} s`
      : px == null || ask == null ? `no ${tokName(token)} ${maker ? "bid or ask" : "ask"}`
      : px < MIN_PX || px > this.cfg.maxPrice + 1e-9 ? `${tokName(token)} ${pxWord} ${cents(px)}, outside ${cents(MIN_PX)}-${cents(this.cfg.maxPrice)}` : null;
    const sig = `${m.dir === "up" ? "▲" : "▼"} ${m.move > 0 ? "+" : ""}${cents(m.move)}`;
    if (why) { this.skipped = `signal ${sig} skipped: ${why}`; return; }
    // maker: the shares already at its price are ahead of it (an Up bid at b sits on the Up bids, a Down bid at b on the Up
    // asks at 1 − b); past PAIR_MAX_QUEUE it would not reach the front in its life
    if (maker && this.cfg.maxQueue != null) {
      const ahead = queueAt(c.book, token, px!);
      if (ahead > this.cfg.maxQueue) {
        this.skipped = `signal ${sig} skipped: ${Math.round(ahead)} sh already bid at ${cents(px!)} (over ${this.cfg.maxQueue})`;
        this.log(`[pair] ${sig} at ${Math.round(c.elapsed)} s: no bid, ${Math.round(ahead)} sh already at ${tokName(token)} ${cents(px!)} (PAIR_MAX_QUEUE ${this.cfg.maxQueue})`);
        return;
      }
    }
    // maker: the token's best bid, post-only (the venue refuses it if the ask came down to it meanwhile)
    const limit = maker ? px! : Math.min(0.99, r4(Math.round((ask! + this.cfg.slip) / c.tick) * c.tick));
    const size = Math.min(this.cfg.size, Math.floor(this.trader.free() / limit + 1e-9));
    if (size < c.minSize) { this.skipped = `signal ${sig} skipped: the free balance covers ${size} sh at ${cents(limit)} (min ${c.minSize})`; return; }
    const id = this.nextId++, usd = Math.max(MIN_USD, toCents(size * limit));
    const why1 = `pair #${id} leg 1 · signal ${sig} (target ${cents(m.target.bid0 ?? NaN)}/${cents(m.target.ask0 ?? NaN)} → ${cents(m.target.bid ?? NaN)}/${cents(m.target.ask ?? NaN)}, book ${m.book.move ? `${m.book.move > 0 ? "+" : ""}${cents(m.book.move)}` : "unmoved"}) · ` +
      (maker ? `${size} ${tokName(token)} bid @ ${cents(limit)} post-only for ${this.cfg.makerMs} ms, ask ${cents(ask!)}` : `${size} ${tokName(token)} ≤ ${cents(limit)}, ask ${cents(ask!)}`);
    const o = maker ? this.trader.bid(c.win, token, limit, size, why1, now) : this.trader.take(c.win, token, limit, size, why1, now, usd);
    if (!o) { this.skipped = `signal ${sig} skipped: no orders may go out now`; return; }
    const rec: PairRec = {
      id, win: c.win, seq: m.seq, t: m.t, dir: m.dir, move: m.move, token, ask0: ask!, limit, size, kind: maker ? "maker" : "taker",
      signal: this.cfg.signal, lookbackMs: m.lookbackMs,
      leg1: { qty: 0, px: null, fee: 0, at: null }, leg2: { qty: 0, px: null, fee: 0, at: null, tries: 0 }, pnl: null, end: null, note: "",
    };
    let list = this.recs.get(c.win);
    if (!list) { list = []; this.recs.set(c.win, list); for (const k of this.recs.keys()) if (k < c.win - 3600) this.recs.delete(k); }
    list.push(rec);
    this.cur = { rec, entry: o, exits: [], closeAt: null, nextTry: 0, cancelAt: maker ? now + this.cfg.makerMs : null, stopMid: null, stopUntil: null, l2Go: false };
    this.skipped = null;
    this.log(`[pair] #${id} ${sig} at ${Math.round(c.elapsed)} s → leg 1: ${size} ${tokName(token)} ` +
      (maker ? `bid @ ${cents(limit)} for ${this.cfg.makerMs} ms (ask ${cents(ask!)})` : `≤ ${cents(limit)} (ask ${cents(ask!)})`));
  }

  /** Each step, after the exchange's fills are booked: leg 1's outcome, the hold, leg 2 and its retries. */
  step(c: PairCtx, now: number): void {
    const L = this.cur;
    if (!L) return;
    const r = L.rec;
    this.collect(L);
    // the window rolled: its market closed and took whatever was still out with it
    if (r.win !== c.win) return this.finish(L, r.leg1.qty < 1e-6 ? "missed" : "held", now, "the window closed with the pair open");
    if (r.leg1.at == null) {
      // a maker bid's life is up: cancel it; a fill that lands before the venue confirms still counts
      if (L.cancelAt != null && now >= L.cancelAt && working(L.entry)) {
        L.cancelAt = null;
        this.trader.cancel(L.entry, now, `pair #${r.id} leg 1: ${this.cfg.makerMs} ms up`);
      }
      if (working(L.entry)) return;
      r.leg1.at = now;
      if (r.leg1.qty < 1e-6) return this.finish(L, "missed", now, r.kind === "maker"
        ? (L.entry.status === "rejected" ? `the bid at ${cents(r.limit)} was refused (post-only: the ask came down to it)` : `no fill at ${cents(r.limit)} in ${this.cfg.makerMs} ms`)
        : `nothing within ${cents(r.limit)}`);
      if (r.leg1.qty < c.minSize - 1e-9) return this.finish(L, "held", now, `leg 1 filled ${r.leg1.qty}, under the ${c.minSize}-share minimum: held to the label`);
      L.closeAt = Math.min(now + this.cfg.holdMs, (c.endTs - this.cfg.closeLeftSec) * 1000);
      if (this.cfg.stopMove != null) { L.stopUntil = now + this.cfg.stopMs; L.stopMid = upMid(c.book); }
      // the leg-2 model, on what the rows show now: scored on every fill, acting only where armed
      let l2 = "";
      if (this.l2) {
        const x = l2Features(c.rows, c.cols, r.t / 1000 - r.win, now / 1000 - r.win, r.dir === "up" ? 1 : -1, Math.abs(r.move), r.ask0, c.Kcl);
        const p = x ? r4(this.l2.prob(x)) : null, armed = this.l2Armed(r.win);
        const fired = armed && p != null && p >= this.cfg.l2ModelP - 1e-9;
        r.l2 = { p, armed, fired }; L.l2Go = fired;
        l2 = ` · leg-2 model P(against) ${p == null ? "—" : p.toFixed(2)}` + (fired ? ` ≥ ${this.cfg.l2ModelP.toFixed(2)} → leg 2 now` : armed ? "" : " (control window)");
      }
      this.log(`[pair] #${r.id} leg 1 filled ${r.leg1.qty} ${tokName(r.token)} @ ${cents(r.leg1.px!)}, leg 2 in ${Math.max(0, L.closeAt - now)} ms` +
        (this.cfg.closeEdge != null ? ` or at a ${cents(this.cfg.closeEdge)} edge` : "") +
        (this.cfg.stopMove != null ? ` or on a ${cents(this.cfg.stopMove)} Up mid move against it in ${this.cfg.stopMs} ms` +
          (L.stopMid != null ? ` (from ${cents(L.stopMid)})` : "") : "") + l2);
      return;
    }
    const ex = L.exits[L.exits.length - 1];
    if (ex && working(ex)) return;
    const left = r4(r.leg1.qty - r.leg2.qty);
    if (left < 1e-6) return this.finish(L, "paired", now, "");
    if (r.leg2.qty > 1e-6 && left < c.minSize - 1e-9) return this.finish(L, "held", now, `${left} ${tokName(r.token)} left unpaired, under the ${c.minSize}-share minimum`);
    const other: Token = r.token === "UP" ? "DOWN" : "UP";
    const ask = otherAsk(c.book, other);
    // in the hold: leg 2 goes at once when the leg-2 model fired at the fill, when the Up mid has moved PAIR_STOP_MOVE
    // against leg 1 (within PAIR_STOP_MS of its fill), or when the other token's ask already locks PAIR_CLOSE_EDGE
    if (L.stopUntil != null && L.stopMid == null) L.stopMid = upMid(c.book);
    let by: "edge" | "hold" | "stop" | "model" = "hold", mid: number | null = null;
    if (r.leg2.tries === 0 && now < L.closeAt!) {
      if (now < L.nextTry) return;
      mid = upMid(c.book);
      const against = L.stopUntil == null || now > L.stopUntil || mid == null || L.stopMid == null ? null
        : (r.token === "UP" ? L.stopMid - mid : mid - L.stopMid);
      if (L.l2Go) by = "model";
      else if (against != null && against >= this.cfg.stopMove! - 1e-9) by = "stop";
      else if (ask == null || this.cfg.closeEdge == null || edgeAt(r, ask) < this.cfg.closeEdge - 1e-9) return;
      else by = "edge";
    } else if (now < (r.leg2.tries > 0 ? L.nextTry : Math.max(L.closeAt!, L.nextTry))) return;      // a short leg 2 goes again at once, whatever sent it
    if (ask == null) { L.nextTry = now + RETRY_MS; return; }
    const limit = Math.min(0.99, r4(Math.round((ask + this.cfg.closeSlip) / c.tick) * c.tick)), usd = Math.max(MIN_USD, toCents(left * ask));
    const o = this.trader.take(r.win, other, limit, left,
      `pair #${r.id} leg 2${r.leg2.tries ? ` (try ${r.leg2.tries + 1})` : ""} · ${left} ${tokName(other)} ≤ ${cents(limit)}, ask ${cents(ask)} · pairs ${r.leg1.qty} ${tokName(r.token)} @ ${cents(r.leg1.px!)}`, now, usd);
    L.nextTry = now + RETRY_MS;
    if (!o) return;
    if (r.leg2.tries === 0) {
      const e = r4(edgeAt(r, ask));
      r.leg2.by = by; r.leg2.edge = e;
      const after = `${((now - r.leg1.at!) / 1000).toFixed(1)} s after leg 1 → leg 2 now`;
      if (by === "edge") this.log(`[pair] #${r.id} edge ${cents(e)} at the ${tokName(other)} ask ${cents(ask)}, ${after}`);
      if (by === "stop") this.log(`[pair] #${r.id} stop: the Up mid ${cents(L.stopMid!)} → ${cents(mid!)}, against the ${tokName(r.token)} leg 1, ${after} (edge ${cents(e)})`);
      if (by === "model") this.log(`[pair] #${r.id} leg-2 model: P(against) ${r.l2!.p!.toFixed(2)} at the fill, ${after} (edge ${cents(e)} at the ${tokName(other)} ask ${cents(ask)})`);
    }
    L.exits.push(o); r.leg2.tries++;
  }

  /** The legs' fills so far, from the trader's log. */
  private collect(L: Live): void {
    const r = L.rec, f1 = this.trader.fillsOf(r.win, L.entry.id);
    r.leg1.qty = r4(f1.qty); r.leg1.px = r6(f1.px); r.leg1.fee = f1.fee;
    let q = 0, cost = 0, fee = 0;
    for (const o of L.exits) { const f = this.trader.fillsOf(r.win, o.id); q += f.qty; cost += (f.px ?? 0) * f.qty; fee += f.fee; }
    r.leg2.qty = r4(q); r.leg2.px = q > 1e-9 ? r6(cost / q) : null; r.leg2.fee = fee;
  }

  private finish(L: Live, end: NonNullable<PairRec["end"]>, now: number, note: string): void {
    // the pairs: leg 2 may buy a little more than leg 1 (a better price than its ask buys more shares); the rest of
    // either leg is held to the label, and its fee share with it
    const r = L.rec, n = Math.min(r.leg1.qty, r.leg2.qty), other = tokName(r.token === "UP" ? "DOWN" : "UP");
    const fees = n > 1e-6 ? r.leg1.fee * (n / r.leg1.qty) + r.leg2.fee * (n / r.leg2.qty) : 0;
    if (n > 1e-6) {
      r.leg2.at = now;
      r.pnl = n * (1 - r.leg1.px! - r.leg2.px!) - fees;
    }
    r.end = end; r.note = note;
    this.cur = null;
    const held = r4(r.leg1.qty - n), extra = r4(r.leg2.qty - n);
    this.log(`[pair] #${r.id} ${end}` + (n > 1e-6 ? `: ${r4(n)} ${tokName(r.token)} @ ${cents(r.leg1.px!)} + ${other} @ ${cents(r.leg2.px!)}` +
      ` = ${cents(r.leg1.px! + r.leg2.px!)} a pair, fees $${fees.toFixed(3)} → ${usd(r.pnl!)}` : "") +
      (held > 1e-6 && end !== "missed" ? ` · ${held} ${tokName(r.token)} held to the label` : "") +
      (extra > 1e-6 ? ` · ${extra} ${other} over the pairs, held to the label` : "") + (note ? ` · ${note}` : ""));
  }

  /** The window's pairs, for its archive file. */
  records(win: number): PairRec[] { return this.recs.get(win) ?? []; }

  /** Restarted inside a window: its archived pairs carry on (one open at the restart stays as it was: unfinished). */
  resume(win: number, recs: PairRec[]): void {
    this.recs.set(win, recs);
    this.nextId = Math.max(this.nextId, ...recs.map((r) => r.id + 1));
  }

  /** The dashboard's row: what the pair trade is doing. */
  actions(c: PairCtx, now: number): Action[] {
    const L = this.cur, done = this.records(c.win).filter((r) => r.end != null);
    const pnl = done.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const tally = `${done.filter((r) => r.end === "paired").length} paired, ${done.filter((r) => r.end === "missed").length} missed this window, ${usd(pnl)}`;
    if (!L) return [{ side: "pair", act: "idle", note: `waiting for ${this.signalDesc()} · ${tally}${this.skipped ? ` · ${this.skipped}` : ""}` }];
    const r = L.rec;
    if (r.leg1.at == null) return [r.kind === "maker"
      ? { side: "pair", act: "place", note: `#${r.id} leg 1: ${r.size} ${tokName(r.token)} bid @ ${cents(r.limit)}, ${r.leg1.qty} filled · ${tally}` }
      : { side: "pair", act: "take", note: `#${r.id} leg 1: ${r.size} ${tokName(r.token)} ≤ ${cents(r.limit)} on its way · ${tally}` }];
    const ex = L.exits[L.exits.length - 1];
    if (ex && working(ex)) return [{ side: "pair", act: "take", note: `#${r.id} leg 2: ${r4(r.leg1.qty - r.leg2.qty)} ${tokName(ex.token)} ≤ ${cents(ex.tokenPrice)} on its way · ${tally}` }];
    const b = c.book, bid = !b.ready ? null : r.token === "UP" ? b.bestBid : b.bestAsk != null ? r4(1 - b.bestAsk) : null;
    const other: Token = r.token === "UP" ? "DOWN" : "UP", a2 = otherAsk(b, other), m = upMid(b);
    const stop = this.cfg.stopMove == null || L.stopUntil == null || now > L.stopUntil ? ""
      : ` or on a ${cents(this.cfg.stopMove)} Up mid move against it for ${L.stopUntil - now} ms` +
        (m != null && L.stopMid != null ? ` (now ${cents(r.token === "UP" ? m - L.stopMid : L.stopMid - m)} its way)` : "");
    return [{ side: "pair", act: "hold", note: `#${r.id} holding ${r.leg1.qty} ${tokName(r.token)} @ ${cents(r.leg1.px!)}` +
      (bid != null ? `, bid now ${cents(bid)} (${bid >= r.leg1.px! ? "+" : ""}${cents(bid - r.leg1.px!)})` : "") +
      ` · leg 2 in ${Math.max(0, (L.closeAt ?? now) - now)} ms` + (this.cfg.closeEdge != null ? ` or at a ${cents(this.cfg.closeEdge)} edge` +
        (a2 != null ? ` (now ${cents(edgeAt(r, a2))} at the ${tokName(other)} ask ${cents(a2)})` : "") : "") + stop +
      (r.l2 ? ` · leg-2 model P(against) ${r.l2.p == null ? "—" : r.l2.p.toFixed(2)}${r.l2.armed ? "" : " (control window)"}` : "") + ` · ${tally}` }];
  }
}
