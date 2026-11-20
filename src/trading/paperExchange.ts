// PAPER EXCHANGE — simulated maker orders on the live Polymarket book. Nothing leaves this process.
//
// Latency   place and cancel each take PAPER_LATENCY_MS one way, timed exactly (not rounded to the
//           frame): an order is on the book from ackDue, prints received from then on count, and a cancel
//           in flight can still be filled until cancelDue, after which nothing more is credited to it.
// Post-only at the ack, an order that would cross the book is rejected (a real post-only order is).
// Tick      at the ack, a price off the market's grid is rejected: 1¢ until the CLOB's tick_size_change, then 0.1¢.
// Cover     at the ack, a SELL needing more Up than is held, net of the other SELLs already on the book, is
//           rejected (Polymarket checks the token balance). The order manager never sends one; this is the
//           venue's own check.
// Queue     a new order joins the BACK of its price level: queue = the level's size when it goes live.
//           It moves up when
//             · a print at our price eats from the front (prints at our price beyond the queue ahead
//               would have hit us: that overflow is our fill), and
//             · the level shrinks below our queue (whatever left was ahead of us).
//           Cancels from a level that stays above our queue are assumed to be BEHIND us (conservative).
//           The level is clamped against its MAX over the last 500 ms, because Polymarket often sends the
//           price_change before the print of the same match (probe 2026-10-07); clamping at once would
//           count that match twice.
// Through   a taker print strictly through our price (a sell below our bid) would have hit us first.
// Cross     resting opposite liquidity at or through our price (an ask posted at or under our bid)
//           would have matched us; we take it once.
// Tape      each match prints on ONE token only, so the tape is Up prints plus Down prints mapped into
//           Up terms (price 1 − p, taker side flipped). Only prints whose TAKER is on the other side of
//           our order count: a taker SELL can fill our bid, a taker BUY our ask.
// Fill      always at our limit price (we are the maker). Our own size never shows in the real book, so
//           market impact is ignored.
// SWEEP     (PAPER_FILL_MODEL=sweep, the default since 2026-10-13; the above is the "queue" model) calibrated on the live
//           bot's first 2,644 real orders, whose 1,018 filled shares the queue model put at 407 (README "Fill model
//           calibration"). What the real fills showed: a taker is held 150 ms and fills against the book at the end of
//           it, and a cancel that reaches the venue after the taker arrived is refused ("already matched": 88 of 114);
//           each taker trade prints ONCE at its volume-weighted price, though it may sweep several levels; we were the
//           first maker at our price in most fills that stopped there (faster makers had cancelled ahead of us). So
//           fills come only from prints: each print's sweep is rebuilt on the book `bookLagMs` before it, walked best
//           price first until its size is used up, and pinned to the printed VWAP (liquidity the book missed is added at
//           the best price; liquidity the taker did not find is taken off the top, and at our price it was ahead of us).
//           An order is in the sweep if it reached the venue (sent + placeMs) before the taker arrived (print exchange
//           time − the taker delay) and its cancel (sent + cancelMs) did not. No cross fills: a crossing order is a
//           taker and prints. A cancelled order stays fillable until no print can reach it any more.
//           placeMs and cancelMs are constants, or with PAPER_SWEEP_LAT (the default since 2026-10-23) drawn per order
//           from the live market maker's own times (venueLatency.ts): calm, or swept for the orders sent or cancelled
//           within 150 ms of a taker whose sweep reached our price, and for a while after one or after a big target move.
// Live rules put in on 2026-10-23 (README "Paper vs live, 5 windows"; each has a knob so older replays can be repeated):
// Self-cross the venue's post-only check counts OUR OWN resting orders: a Down bid whose Up-ask price is at or under our
//           resting Up bid is refused ("post_only_would_cross"; 17 of the live bot's 113 refusals in 5 windows had such
//           an order of ours within 300 ms; the rest were the live bot's ~50 ms book lag, README). Checked at the ack
//           against our orders on the venue at that moment (PAPER_SELF_CROSS).
// Off       the order manager's pending-order cap (MM_CAP_PENDING) counts a cancelling order until the venue's cancel
//           answer (Order.offAt = the cancel's landing + ANSWER_MS), as live; the exchange itself keeps the order
//           fillable until no taker that arrived before the cancel landed can print any more (PAPER_PENDING_UNTIL).
// Early     PAPER_EARLY_CANCEL (default LIVE_EARLY_CANCEL; drawn venue times only): a cancel does not wait for the post's
//           answer (live: it goes by the order's signed id), and one that reaches the venue before its order is placed
//           means the order never rests: the venue refuses the post "Already canceled" (real 1¢ orders, 2026-10-29).
// Hold      PAPER_TAKER_HOLD (default on; .env off since 2026-11-06, tag "+nh"): on, a cancel that lands after the taker
//           arrived (print time − 150 ms) is refused, as the 10-13 calibration read its fills. That calibration saw only
//           fills, never the escapes: 70% of paper maker fills 11-02..05 needed this rule, and live run 1's cancels that
//           landed inside the hold filled 2 of 12 (6 of 8 landed after the print). Off: the cancel escapes if it landed before
//           the print's match time. Placement keeps the arrival cut, so off only removes fills.
// Heard     a fill reaches the trader PAPER_FILL_HEARD_MS (80) after the venue's match time: the user channel's delay
//           live (heard − venue: median 80 ms, p90 84, on 52 live fills). The order's own filled size moves at the
//           match (the venue's truth, and the walk needs it); the fill's time stays the match seen on the feed.
// Take      a taker order (fill-and-kill; v4's flow and rebalance takes, taker.ts) skips post-only: it reaches the book after
//           PAPER_TAKE_MS (by default the latency plus the crypto markets' taker delay, 150 ms), then walks the opposite levels of the book
//           up to its limit, filling at each level's price and paying 0.07 · p(1−p) a share; the rest is
//           cancelled. Our size does not deplete the real book (as for maker fills). As live (2026-11-05): a take spends
//           USDC, its budget or size × limit in whole cents, buying what that pays for at each level up to the limit (more
//           shares than `size` when it fills under the limit), and one under the venue's $1 minimum is refused.
//           PAPER_TAKE_MS=live draws each take's send → match from the live takes' answer times (LIVE_TAKE_MS).
import type { BookView, Print } from "../feeds/pmBook.js";
import type { Exchange } from "./exchange.js";
import { cancelKind, cents, r4, EPS, type Emit, type Fill, type FillVia, type Order, type Side, type Token } from "./types.js";
import { ANSWER_MS, SWEPT_NEAR_MS, VenueLatency, liveTakeMs, type LatCfg } from "./venueLatency.js";

/** The venue refuses a market BUY under $1 (live run 4: 10 of 59 takes, "invalid amount"). */
export const TAKE_MIN_USD = 1;

export const QUEUE_GRACE_MS = 500;
/** Finished orders stay visible this long, then leave the working set. */
const LINGER_MS = 3000;

interface Tape { price: number; size: number; side: Side; rx: number; ts: number }

/** The sweep fill model's timings (null = the queue model). lat: place and cancel times drawn per order (null = the
 *  constants placeMs / cancelMs). selfCross: the venue's post-only check sees our own orders (PAPER_SELF_CROSS).
 *  heardMs: a fill reaches the trader this long after the venue's match (PAPER_FILL_HEARD_MS; 0 = as it prints).
 *  pendingUntil: "ack" = a cancelling order leaves the pending-order cap at the venue's cancel answer (Order.offAt),
 *  "tail" = once no print can reach it (the rule before 2026-10-23). The three default on / 80 / "ack" when unset. */
export interface SweepCfg {
  placeMs: number; cancelMs: number; bookLagMs: number; feedLagMs: number; lat?: LatCfg | null;
  selfCross?: boolean; heardMs?: number; pendingUntil?: "ack" | "tail";
  /** PAPER_EARLY_CANCEL (header, "Early"); acts with drawn venue times (lat). */
  earlyCancel?: boolean;
  /** PAPER_TAKER_HOLD (header, "Hold"; default on = the rule before 2026-11-06): a cancel that lands during the taker's
   *  150 ms delay is too late. Off: it escapes unless it landed after the print's match time. */
  hold?: boolean;
}
/** Up-book views kept for the sweep model, which walks the book as it was shortly before each print. */
const HIST_MS = 600;

/** An order as sent: a `side` (default BUY) of `token` (default UP) at `price` in that token's terms. */
/** usd: a take's USDC budget (Order.usd): it fills up to that much at prices up to `price`, the shares however many it buys. */
export interface PlaceReq { win: number; token?: Token; side?: Side; price: number; size: number; reason: string; take?: boolean; usd?: number }

/** Polymarket's taker fee per share at token price p (feeSchedule rate 0.07, exponent 1). */
export const takerFee = (p: number) => 0.07 * p * (1 - p);

/** Up-terms view of a token price: Down at q sits on the mirrored Up book at 1 − q, on the other side. */
const upTerms = (token: Token, side: Side, price: number): { side: Side; price: number } =>
  token === "UP" ? { side, price } : { side: side === "BUY" ? "SELL" : "BUY", price: r4(1 - price) };
/** An Up-terms price shown in the order's own token. */
const inTok = (o: Order, upPrice: number) => (o.token === "UP" ? upPrice : r4(1 - upPrice));
const tokName = (o: Order) => (o.token === "UP" ? "Up" : "Down");
const evTok = (o: Order) => ({ token: o.token, tokenSide: o.tokenSide, tokenPrice: o.tokenPrice });

export class PaperExchange implements Exchange {
  private orders = new Map<number, Order>();
  private tape: Tape[] = [];
  private hist: { t: number; book: BookView }[] = [];
  /** Sweep model: each order's queue has been capped by the level in the book views up to this time. */
  private clampT = new Map<number, number>();
  private upTok: string | null = null;
  private dnTok: string | null = null;
  /** Sweep model with PAPER_SWEEP_LAT: the drawn times, and each window's draws for its summary line. */
  private readonly lat: VenueLatency | null;
  private latLog = new Map<number, { place: [number, boolean][]; cancel: [number, boolean][] }>();
  /** Sweep model: fills matched at the venue but not yet heard (PAPER_FILL_HEARD_MS). */
  private held: { due: number; f: Fill }[] = [];
  nextId: number;
  nextFillId: number;

  /** upHeld(win): Up shares held in that window, for the venue's SELL balance check (none = unchecked). takeMs: a take's
   *  send → match (PAPER_TAKE_MS); takeLive: drawn per take from the live takes' answer times instead (PAPER_TAKE_MS=live). */
  constructor(private readonly latencyMs: number, private readonly emit: Emit, startId = 1, startFillId = 1,
              private readonly upHeld?: (win: number) => number, private readonly takerDelayMs = 150,
              private readonly sweep: SweepCfg | null = null, private readonly takeMs = latencyMs + takerDelayMs,
              private readonly takeLive = false, private readonly cancelDelayMs = 0) {
    this.nextId = startId;
    this.nextFillId = startFillId;
    this.lat = sweep?.lat ? new VenueLatency(sweep.lat) : null;
  }

  /** The engine's latency detector saw a big target move: the venue is slow for a while (PAPER_SWEEP_LAT). */
  noteMove(now: number): void { this.lat?.noteMove(now); }

  /** PAPER_SWEEP_LAT: was the venue busy for an order sent (or cancelled) at `t`, in the race against a taker that
   *  arrived at `arr`: the sweep's own orders meet the swept tables, as measured. */
  private busyFor(t: number, arr: number): boolean { return this.lat!.busyAt(t) || Math.abs(t - arr) <= SWEPT_NEAR_MS; }

  /** When the order reached the venue, for the race against a taker arriving at `arr`. */
  private placeAt(o: Order, arr: number, cfg: SweepCfg): number {
    return o.createdAt + (this.lat && o.placeU != null ? this.lat.at("place", o.placeU, this.busyFor(o.createdAt, arr), o.placeNewBest) : o.placeMs ?? cfg.placeMs);
  }

  /** When its cancel reached the venue (o.cancelAt set), for the race against a taker arriving at `arr`. */
  private cancelLand(o: Order, arr: number, cfg: SweepCfg): number {
    return o.cancelAt! + (this.lat && o.cancelU != null ? (o.cancelWait ?? 0) + this.lat.at("cancel", o.cancelU, this.busyFor(o.cancelAt!, arr)) : o.cancelMs ?? cfg.cancelMs);
  }

  /** The latest the cancel can have landed, whichever table the race resolves it against. */
  private cancelMax(o: Order, cfg: SweepCfg): number {
    return this.lat && o.cancelU != null ? (o.cancelWait ?? 0) + Math.max(this.lat.at("cancel", o.cancelU, true), this.lat.at("cancel", o.cancelU, false)) : o.cancelMs ?? cfg.cancelMs;
  }

  private logLat(win: number, kind: "place" | "cancel", ms: number, busy: boolean): void {
    let l = this.latLog.get(win);
    if (!l) this.latLog.set(win, (l = { place: [], cancel: [] }));
    l[kind].push([ms, busy]);
  }

  /** The current window's tokens. A change drops the tape (prints from another market). */
  setTokens(up: string | null, down: string | null): void {
    if (up === this.upTok && down === this.dnTok) return;
    this.upTok = up; this.dnTok = down; this.tape = []; this.hist = [];
  }

  /** Every print from the book socket; called as it arrives. */
  onPrint(p: Print): void {
    if (p.asset === this.upTok) this.tape.push({ price: p.price, size: p.size, side: p.side === "SELL" ? "SELL" : "BUY", rx: p.rx, ts: p.ts });
    else if (p.asset === this.dnTok) this.tape.push({ price: r4(1 - p.price), size: p.size, side: p.side === "SELL" ? "BUY" : "SELL", rx: p.rx, ts: p.ts });
    if (this.tape.length > 5000) this.tape.splice(0, this.tape.length - 5000);
  }

  place(req: PlaceReq, now: number): Order {
    const token = req.token ?? "UP", tokenSide = req.side ?? "BUY", u = upTerms(token, tokenSide, r4(req.price));
    // sweep: this order's send → at the venue, drawn (PAPER_SWEEP_LAT) or the constant; a new-best post from its own table
    // (PAPER_NEWBEST_LAT), judged on the latest book view at the send, as live judges it on its frame book
    const nb = !!(this.sweep && !req.take && this.lat?.newBestOn && this.newBestAt(u.side, u.price));
    const d: { ms: number; busy: boolean; u: number | null } | null = this.sweep && !req.take ? this.lat?.place(now, nb) ?? { ms: this.sweep.placeMs, busy: false, u: null } : null;
    const o: Order = {
      id: this.nextId++, win: req.win, side: u.side, price: u.price, token, tokenSide, tokenPrice: r4(req.price), size: req.size, filled: 0,
      // sweep: the venue's post-only check at its arrival (sent + placeMs), as our feed shows that moment (+ feedLagMs)
      status: "pending", reason: req.reason, createdAt: now,
      ackDue: now + (req.take ? (this.takeLive ? liveTakeMs(Math.random()) : this.takeMs) : d ? d.ms + this.sweep!.feedLagMs : this.latencyMs),
      liveAt: null, cancelDue: null, doneAt: null, queue: 0, queue0: 0, lv: [], crossUsed: 0, take: !!req.take,
      // a take spends USDC as live's market BUY does: its budget, else size × limit in whole cents (liveExchange.place)
      ...(req.take ? { usd: req.usd ?? Math.max(0.01, Math.round(req.size * r4(req.price) * 100) / 100) } : {}),
      ...(d ? { placeMs: d.ms } : {}), ...(d && this.lat ? { placeBusy: d.busy, placeU: d.u! } : {}), ...(nb ? { placeNewBest: true } : {}),
    };
    if (d && this.lat) this.logLat(o.win, "place", d.ms, d.busy);
    this.orders.set(o.id, o);
    this.emit({ t: now, win: o.win, oid: o.id, type: "place", side: o.side, price: o.price, size: o.size,
      note: req.reason + (o.usd != null ? ` · fill-and-kill, $${o.usd.toFixed(2)}` : ""), ...evTok(o) });
    if (o.take && o.usd! < TAKE_MIN_USD - 1e-9) this.finish(o, "rejected", now, `take: $${o.usd!.toFixed(2)} is under the venue's $${TAKE_MIN_USD} minimum`);
    return o;
  }

  cancel(o: Order, now: number, why: string): void {
    if (o.status !== "pending" && o.status !== "open") return;
    o.status = "cancelling";
    o.cancelDue = now + this.cancelDelayMs + this.latencyMs;
    o.cancelAt = now;
    o.cancelWhy = why;
    // MM_CANCEL_DELAY_MS: the cancel is sent that long after the decision (counted from cancelAt, as the post's wait)
    let wait = o.take ? 0 : this.cancelDelayMs;
    if (this.sweep && !o.take) {
      const d: { ms: number; busy: boolean; u: number | null } = this.lat?.cancel(now) ?? { ms: this.sweep.cancelMs, busy: false, u: null };
      // drawn times: as live, the cancel goes out once the post's answer has brought the venue's order id (unless
      // PAPER_EARLY_CANCEL: then at once, by the id the order was signed with)
      if (this.lat && !this.sweep.earlyCancel) wait = Math.max(wait, o.createdAt + (o.placeMs ?? 0) + ANSWER_MS - now);
      else if (!this.lat) wait = 0;      // constant venue times: the delay is in cancelMs below
      o.cancelMs = wait + d.ms + (this.lat ? 0 : (o.take ? 0 : this.cancelDelayMs));
      if (this.lat) { o.cancelBusy = d.busy; o.cancelU = d.u!; o.cancelWait = wait; this.logLat(o.win, "cancel", d.ms, d.busy); }
      // the venue's cancel answer: the order manager stops counting the order toward the pending cap then, as live
      if ((this.sweep.pendingUntil ?? "ack") === "ack") o.offAt = now + o.cancelMs + ANSWER_MS;
    }
    this.emit({ t: now, win: o.win, oid: o.id, type: "cancel", side: o.side, price: o.price, size: o.size - o.filled,
      note: wait > 0 ? `${why} · ${wait > this.cancelDelayMs || o.take ? `waits ${wait} ms for the post's answer` : `sent after the ${wait} ms cancel delay`}` : why, ...evTok(o) });
  }

  /** Market closed: every order of that window is gone at once, no latency, no more fills. */
  closeWindow(win: number, now: number): void {
    for (const o of this.orders.values()) {
      if (o.win !== win || !active(o)) continue;
      this.finish(o, "cancelled", now, `market closed · ${fmtFill(o)}`);
    }
    this.latSummary(win, now);
  }

  /** PAPER_SWEEP_LAT: the window's drawn times in one info line: how often the venue was busy, and the medians. */
  private latSummary(win: number, now: number): void {
    const l = this.latLog.get(win);
    this.latLog.delete(win);
    if (!l) return;
    const med = (xs: number[]) => (xs.length ? `${[...xs].sort((a, b) => a - b)[xs.length >> 1]}` : "—");
    const part = (a: [number, boolean][], name: string) => {
      const busy = a.filter((x) => x[1]).map((x) => x[0]), calm = a.filter((x) => !x[1]).map((x) => x[0]);
      return `${a.length} ${name}, ${a.length ? Math.round((100 * busy.length) / a.length) : 0}% busy, median ${med(a.map((x) => x[0]))} ms ` +
        `(calm ${med(calm)} / busy ${med(busy)})`;
    };
    this.emit({ t: now, win, oid: null, type: "info", side: null, price: null, size: null,
      note: `venue latency drawn (PAPER_SWEEP_LAT): ${part(l.place, "places")} · ${part(l.cancel, "cancels")}` });
  }

  /** Every working order of every window gone at once (account reset). */
  cancelAll(now: number, why: string): void {
    for (const o of this.orders.values()) if (active(o)) this.finish(o, "cancelled", now, `${why} · ${fmtFill(o)}`);
  }

  /** Orders still able to trade (pending, open, cancelling). */
  working(win?: number): Order[] {
    return [...this.orders.values()].filter((o) => active(o) && (win == null || o.win === win));
  }

  /** Working orders plus the ones that just finished, for the dashboard. */
  visible(win: number): Order[] {
    return [...this.orders.values()].filter((o) => o.win === win).sort((a, b) => a.id - b.id);
  }

  /**
   * Advance to `now`: acks, matching against the prints since the last step and the current book, then
   * cancel acks. `book` is the Up book of the window the orders belong to. Fills are returned, not
   * emitted: the caller books them first, so the event can say what they did to inventory.
   */
  step(now: number, win: number, book: BookView, mark: { fv: number | null; mid: number | null }): Fill[] {
    if (this.sweep) return this.stepSweep(now, win, book, mark, this.sweep);
    const tape = this.tape;
    this.tape = [];
    const fills: Fill[] = [];
    for (const o of this.orders.values()) {
      if (!active(o)) {
        if (o.doneAt != null && now - o.doneAt > LINGER_MS) this.orders.delete(o.id);
        continue;
      }
      if (o.win !== win) continue;
      if (o.take) {
        if (o.liveAt == null && now >= o.ackDue) fills.push(...this.takeNow(o, book, now, mark));
        continue;
      }
      let f: Fill | null = null;
      if (o.liveAt == null) {
        if (now >= o.ackDue && this.ack(o, now, book)) f = this.match(o, tape, book, now, mark, true);
      } else if (book.ready) {
        f = this.match(o, tape, book, now, mark, false);
      }
      if (f) fills.push(f);
      if (o.status === "cancelling" && o.cancelDue != null && now >= o.cancelDue) {
        this.finish(o, "cancelled", now, `${fmtFill(o)}${o.liveAt != null ? ` · rested ${((Math.max(o.liveAt, o.cancelDue) - o.liveAt) / 1000).toFixed(1)} s` : " · never reached the book"}`);
      }
    }
    return fills;
  }

  /** The sweep model's step: acks, takes, then every print since the last step against the orders it could reach. */
  private stepSweep(now: number, win: number, book: BookView, mark: { fv: number | null; mid: number | null }, cfg: SweepCfg): Fill[] {
    const tape = this.tape;
    this.tape = [];
    this.hist.push({ t: now, book });
    while (this.hist.length > 1 && this.hist[0].t < now - HIST_MS) this.hist.shift();
    const fills: Fill[] = [];
    // a cancelled order stays fillable until a taker that arrived before its cancel landed has printed (+ the feed's lag)
    const tail = (o: Order) => this.cancelMax(o, cfg) + this.takerDelayMs + 150;
    for (const o of this.orders.values()) {
      if (!active(o)) {
        if (o.doneAt != null && now - o.doneAt > LINGER_MS) this.orders.delete(o.id);
        continue;
      }
      if (o.win !== win) continue;
      if (o.take) {
        if (o.liveAt == null && now >= o.ackDue) fills.push(...this.takeNow(o, book, now, mark));
        continue;
      }
      if (o.liveAt == null && now >= o.ackDue) this.ack(o, now, book);
      if (o.liveAt != null && book.ready) {
        o.lv.push([now, levelSize(book, o.side, o.price)]);       // for the dashboard
        while (o.lv.length > 1 && o.lv[0][0] < now - QUEUE_GRACE_MS) o.lv.shift();
      }
    }
    // fills are heard PAPER_FILL_HEARD_MS after the venue's match (the user channel's delay live); 0 = as they print
    const heard = cfg.heardMs ?? 80;
    for (const p of tape) {
      for (const f of this.sweepPrint(p, win, mark, cfg)) {
        if (heard > 0) this.held.push({ due: p.ts + heard, f }); else fills.push(f);
      }
    }
    if (this.held.length) {
      const keep: { due: number; f: Fill }[] = [];
      for (const h of this.held) if (h.due <= now || h.f.win !== win) fills.push(h.f); else keep.push(h);
      this.held = keep;
    }
    // the queue cap runs behind: a print that arrives later walks the book of up to ~2 × feed lag before now
    for (const o of this.orders.values()) if (o.win === win && active(o) && !o.take && o.liveAt != null) this.clampTo(o, now - 4 * cfg.feedLagMs);
    for (const o of this.orders.values()) {
      if (o.win !== win || o.status !== "cancelling" || o.take || o.cancelAt == null || now < o.cancelAt + tail(o)) continue;
      const cms = o.cancelMs ?? cfg.cancelMs;
      this.finish(o, "cancelled", now, `${fmtFill(o)}${o.liveAt != null ? ` · rested ${((o.cancelAt + cms - o.liveAt) / 1000).toFixed(1)} s` : " · never reached the book"}` +
        (this.lat ? ` · cancel reached the venue ${cms} ms after it was sent${o.cancelBusy ? " (venue busy)" : ""}` : ""));
    }
    return fills;
  }

  /** The level shrank under our queue: those that left were ahead of us. Book views up to `t` only, in order, so a
   *  sweep never sees its own trade's consumption (the current size, not the queue model's 500 ms max: the sweep moves
   *  the queue, as calibrated). */
  private clampTo(o: Order, t: number): void {
    let from = this.clampT.get(o.id) ?? o.liveAt ?? 0;
    for (const h of this.hist) {
      if (h.t <= from) continue;
      if (h.t > t) break;
      if (h.book.ready) { const lvl = levelSize(h.book, o.side, o.price); if (o.queue > lvl) o.queue = lvl; }
      from = h.t;
    }
    this.clampT.set(o.id, from);
  }

  /** A post at this Up-terms side and price would set a new best price on the latest book view: a bid above the best bid
   *  (or on an empty side), an ask (a Down bid) under the best ask. False without a book view (the window's first step). */
  private newBestAt(side: Side, price: number): boolean {
    const b = this.hist[this.hist.length - 1]?.book;
    if (!b?.ready) return false;
    const top = side === "BUY" ? b.bestBid : b.bestAsk;
    return top == null || (side === "BUY" ? price > top + EPS : price < top - EPS);
  }

  /** The Up book as it was at local time t (the latest view at or before it). */
  private bookAt(t: number): BookView | null {
    let b: BookView | null = null;
    for (const h of this.hist) { if (h.t <= t) b = h.book; else break; }
    return b ?? this.hist[0]?.book ?? null;
  }

  /** One print's sweep: the taker's side of the Up book walked best first, pinned to the print's VWAP. */
  private sweepPrint(p: Tape, win: number, mark: { fv: number | null; mid: number | null }, cfg: SweepCfg): Fill[] {
    const lifts = p.side === "BUY";                               // a taker BUY (Up terms) lifts the asks
    const arr = p.ts - this.takerDelayMs;
    // a cancel escapes if it landed before this: the taker's arrival (PAPER_TAKER_HOLD on, the rule before 2026-11-06) or
    // the print's own match time (off: the taker matches the book at the end of its delay, so a cancel during it counts)
    const cxBy = (cfg.hold ?? true) ? arr : p.ts;
    // on the venue when the taker arrived: placed before, cancel not landed (PAPER_SWEEP_LAT: the sweep's own orders
    // resolve their draws against the swept tables, venueLatency.ts)
    const mine = [...this.orders.values()].filter((o) => o.win === win && !o.take && o.liveAt != null && (o.status === "open" || o.status === "cancelling")
      && (o.side === "SELL") === lifts && o.size - o.filled > 1e-6
      && this.placeAt(o, arr, cfg) <= arr && (o.cancelAt == null || cxBy < this.cancelLand(o, arr, cfg)));
    if (!mine.length) return [];
    for (const o of mine) this.clampTo(o, p.rx - cfg.bookLagMs);
    const bk = this.bookAt(p.rx - cfg.bookLagMs);
    if (!bk?.ready) return [];
    const lv = new Map<number, number>();                         // others' size by price key
    for (const [px, sz] of lifts ? bk.asks : bk.bids) lv.set(Math.round(px * 1e4), sz);
    for (const o of mine) if (!lv.has(Math.round(o.price * 1e4))) lv.set(Math.round(o.price * 1e4), 0);
    const ladder = [...lv.keys()].sort((a, b) => (lifts ? a - b : b - a));
    const TOL = 0.0051;
    let reached = false;                                          // the final walk got to a price of ours
    const walk = (adj: number, apply: Map<number, number> | null): number | null => {
      let left = p.size, num = 0, extra = adj;
      for (let i = 0; i < ladder.length && left > EPS; i++) {
        const k = ladder[i], px = k / 1e4, here = mine.filter((o) => Math.round(o.price * 1e4) === k);
        let O = lv.get(k)!, cut = 0;
        if (extra > 0 && i === 0) { O += extra; extra = 0; }
        else if (extra < 0) { cut = Math.min(O, -extra); O -= cut; extra += cut; }
        const total = O + here.reduce((a, o) => a + o.size - o.filled - (apply?.get(o.id) ?? 0), 0);
        if (total <= EPS) continue;
        const take = Math.min(left, total);
        if (apply && here.length) reached = true;
        if (apply) {
          let ahead = 0;
          for (const o of here) {
            const q = Math.max(0, o.queue - cut);              // what left our price in time was ahead of us
            const got = Math.max(0, Math.min(o.size - o.filled, take - Math.max(q, ahead)));
            if (got > 1e-6) apply.set(o.id, got);
            ahead = Math.max(ahead, q) + o.size;
            o.queue = Math.max(0, q - take);
          }
        }
        left -= take; num += take * px;
      }
      return p.size - left > EPS ? num / (p.size - left) : null;
    };
    const tooDeep = (v: number) => (lifts ? v > p.price + TOL : v < p.price - TOL);
    let adj = 0;
    const v0 = walk(0, null);
    if (v0 != null && Math.abs(v0 - p.price) > TOL) {
      let lo = -p.size * 4, hi = p.size * 4;
      if (tooDeep(v0)) lo = 0; else hi = 0;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2, v = walk(mid, null);
        if (v == null || !tooDeep(v)) hi = mid; else lo = mid;
        if (v != null && Math.abs(v - p.price) <= TOL) { adj = mid; break; }
        adj = hi;
      }
    }
    const got = new Map<number, number>();
    walk(adj, got);
    if (reached) this.lat?.noteSweep(arr);                        // the venue is slow around a sweep that reaches our price
    const out: Fill[] = [];
    for (const o of mine) {
      const g = got.get(o.id);
      if (!g) continue;
      const qty = Math.round(g * 100) / 100 || g;
      o.filled = Math.min(o.size, o.filled + qty);
      const f: Fill = {
        id: this.nextFillId++, oid: o.id, win: o.win, t: p.rx, side: o.side, price: o.price, ...evTok(o), size: qty, via: "sweep",
        queue0: o.queue0, restMs: p.rx - (o.liveAt ?? p.rx), fv: mark.fv, mid: mark.mid, mk: [null, null, null], settle: null, note: "", inv: "",
        cxl: o.cancelAt != null, ...(o.cancelAt != null ? { cxlWhy: cancelKind(o.cancelWhy) } : {}),
      };
      const late = o.cancelAt != null ? ` · the taker arrived ${Math.round(arr - o.cancelAt)} ms after our cancel was sent` +
        (this.lat ? ` (the cancel landed at +${Math.round(this.cancelLand(o, arr, cfg) - o.cancelAt)}${this.busyFor(o.cancelAt, arr) ? ", swept" : ""})` : "") : "";
      if (o.size - o.filled < 1e-6) this.finish(o, "filled", p.rx, null);
      f.note = `${o.status === "filled" ? "filled" : `partial, ${fmtSh(o.size - o.filled)} left`} · via ${VIA.sweep} · ${fmtSh(o.queue0)} were ahead · rested ${(f.restMs / 1000).toFixed(1)} s${late}`;
      out.push(f);
    }
    return out;
  }

  /** The order reaches the exchange. True if it is now on the book. */
  private ack(o: Order, now: number, book: BookView): boolean {
    // PAPER_EARLY_CANCEL: the cancel reached the venue before the order did, so the venue refuses the post
    // (unfilled only: the race against a print may resolve the cancel on the swept table, landing later than this draw)
    if (this.sweep?.earlyCancel && this.lat && o.status === "cancelling" && o.cancelAt != null && o.filled < 1e-6 &&
        o.cancelAt + (o.cancelMs ?? this.sweep.cancelMs) <= o.createdAt + (o.placeMs ?? this.sweep.placeMs)) {
      this.finish(o, "cancelled", now, `the cancel beat the post: the venue refused it (already canceled) · ${fmtFill(o)} · never reached the book`);
      return false;
    }
    if (!book.ready) { this.finish(o, "rejected", now, "no book at the ack"); return false; }
    const isBuy = o.side === "BUY";
    // the venue's grid: 1¢ until the market's tick_size_change (both tokens share it; 1 − p is on the same grid)
    const tk = book.tick != null && book.tick > 0 ? book.tick : 0.01;
    if (Math.abs(o.price / tk - Math.round(o.price / tk)) > 1e-6) {
      this.finish(o, "rejected", now, `price ${cents(o.tokenPrice)} is off the ${cents(tk)} tick`);
      return false;
    }
    const opp = isBuy ? book.bestAsk : book.bestBid;          // Up-terms level our order would cross
    if (opp != null && (isBuy ? o.price >= opp - EPS : o.price <= opp + EPS)) {
      this.finish(o, "rejected", now, `post-only: the best ${tokName(o)} ${o.tokenSide === "BUY" ? "ask" : "bid"} moved to ${cents(inTok(o, opp))}, would cross`);
      return false;
    }
    // the venue's check sees our own orders too: a Down bid at or over 1 − our resting Up bid crosses it (PAPER_SELF_CROSS)
    if (this.sweep && (this.sweep.selfCross ?? true) && !o.take) {
      const venueT = o.createdAt + (o.placeMs ?? this.sweep.placeMs);
      for (const x of this.orders.values()) {
        if (x === o || x.win !== o.win || x.take || !active(x) || x.side === o.side) continue;
        if (x.createdAt + (x.placeMs ?? this.sweep.placeMs) > venueT) continue;                       // not there yet
        if (x.cancelAt != null && venueT >= x.cancelAt + (x.cancelMs ?? this.sweep.cancelMs)) continue; // already gone
        if (isBuy ? x.price <= o.price + EPS : x.price >= o.price - EPS) {
          this.finish(o, "rejected", now, `post-only: would cross our own ${tokName(x)} bid #${x.id} at ${cents(x.tokenPrice)} (post_only_would_cross)`);
          return false;
        }
      }
    }
    if (o.token === "UP" && o.tokenSide === "SELL" && this.upHeld) {
      let onBook = 0;
      for (const x of this.orders.values()) if (x !== o && x.win === o.win && x.token === "UP" && x.tokenSide === "SELL" && active(x) && x.liveAt != null) onBook += x.size - x.filled;
      const free = this.upHeld(o.win) - onBook;
      if (free < o.size - 1e-9) { this.finish(o, "rejected", now, `not enough Up: selling ${fmtSh(o.size)} needs ${fmtSh(o.size)}, ${fmtSh(Math.max(0, free))} free`); return false; }
    }
    const lvl = levelSize(book, o.side, o.price);
    o.liveAt = o.ackDue; o.queue = lvl; o.queue0 = lvl; o.lv = [[now, lvl]];
    if (o.status === "pending") o.status = "open";
    const top = isBuy ? book.bestBid : book.bestAsk, ours = `best ${tokName(o)} ${o.tokenSide === "BUY" ? "bid" : "ask"}`;
    const where = top == null ? "alone on its side" : Math.abs(top - o.price) < EPS ? `joins the ${ours}` :
      (isBuy ? o.price > top : o.price < top) ? `improves the ${ours} ${cents(inTok(o, top))}` : `behind the ${ours} ${cents(inTok(o, top))}`;
    this.emit({ t: o.liveAt, win: o.win, oid: o.id, type: "live", side: o.side, price: o.price, size: o.size,
      note: `on the book after ${o.liveAt - o.createdAt} ms${o.placeNewBest ? " (new best at the send: live's delay)" : o.placeBusy ? " (venue busy)" : ""} · ${where} · ${fmtSh(lvl)} sh ahead`, ...evTok(o) });
    return true;
  }

  /**
   * `fresh` = the order went live during this step: its queue was measured on the book as of now, which
   * already reflects the prints at its price since ackDue, so only through-prints and crosses count.
   */
  private match(o: Order, tape: Tape[], book: BookView, now: number, mark: { fv: number | null; mid: number | null }, fresh: boolean): Fill | null {
    const isBuy = o.side === "BUY";
    const taker: Side = isBuy ? "SELL" : "BUY";
    const until = o.cancelDue ?? Infinity;          // once the cancel lands the order is gone
    let viaQueue = 0, viaThrough = 0, viaCross = 0;

    // prints: at our price eat the queue from the front; strictly through our price would have hit us first
    for (const p of tape) {
      if (p.side !== taker || p.rx < (o.liveAt ?? Infinity) || p.rx >= until) continue;
      if (Math.abs(p.price - o.price) < EPS) {
        if (fresh) continue;
        o.queue -= p.size;
        if (o.queue < 0) { viaQueue += -o.queue; o.queue = 0; }
      } else if (isBuy ? p.price < o.price : p.price > o.price) {
        viaThrough += p.size;
      }
    }

    // resting opposite liquidity at or through our price would have matched us. The book is as of now,
    // so once the cancel has landed a new cross cannot be told apart from one after it: credit none.
    if (now < until) {
      let crossVol = 0;
      for (const [px, sz] of isBuy ? book.asks : book.bids) {
        if (isBuy ? px <= o.price + EPS : px >= o.price - EPS) crossVol += sz; else break;
      }
      if (crossVol > o.crossUsed + EPS) viaCross = crossVol - o.crossUsed;
      o.crossUsed = crossVol > EPS ? Math.max(o.crossUsed, crossVol) : 0;
    }

    // level shrink: clamp the queue to the level's max over the grace window
    const lvl = levelSize(book, o.side, o.price);
    o.lv.push([now, lvl]);
    while (o.lv.length > 1 && o.lv[0][0] < now - QUEUE_GRACE_MS) o.lv.shift();
    let hi = 0; for (const [, v] of o.lv) if (v > hi) hi = v;
    if (o.queue > hi) o.queue = hi;

    const left = o.size - o.filled;
    const got = Math.min(left, viaQueue + viaThrough + viaCross);
    if (got < 1e-6) return null;
    const qty = Math.round(got * 100) / 100 || got;
    const via: FillVia = viaCross >= viaThrough && viaCross >= viaQueue ? "cross" : viaThrough >= viaQueue ? "through" : "queue";
    o.filled = Math.min(o.size, o.filled + qty);
    const f: Fill = {
      id: this.nextFillId++, oid: o.id, win: o.win, t: now, side: o.side, price: o.price, ...evTok(o), size: qty, via,
      queue0: o.queue0, restMs: now - (o.liveAt ?? now), fv: mark.fv, mid: mark.mid, mk: [null, null, null], settle: null, note: "", inv: "",
      cxl: o.status === "cancelling", ...(o.status === "cancelling" ? { cxlWhy: cancelKind(o.cancelWhy) } : {}),
    };
    const late = o.status === "cancelling" ? " · cancel was in flight" : "";
    if (o.size - o.filled < 1e-6) this.finish(o, "filled", now, null);
    f.note = `${o.status === "filled" ? "filled" : `partial, ${fmtSh(o.size - o.filled)} left`} · via ${VIA[via]} · ${fmtSh(o.queue0)} were ahead · rested ${(f.restMs / 1000).toFixed(1)} s${late}`;
    return f;
  }

  /** A taker order at its ack: walk the opposite levels up to the limit, fill-and-kill. */
  private takeNow(o: Order, book: BookView, now: number, mark: { fv: number | null; mid: number | null }): Fill[] {
    o.liveAt = now;
    if (!book.ready) { this.finish(o, "rejected", now, "take: no book at the ack"); return []; }
    if (o.status === "cancelling") { this.finish(o, "cancelled", now, "take: cancelled before it reached the book"); return []; }
    const isBuy = o.side === "BUY", out: Fill[] = [];
    // a USDC budget (Order.usd) buys what it pays for at each level's price, as the venue's market BUY does
    let budget = o.usd ?? null;
    const done = () => (budget != null ? budget < 0.005 : o.size - o.filled < 1e-6);
    for (const [px, sz] of isBuy ? book.asks : book.bids) {
      if (isBuy ? px > o.price + EPS : px < o.price - EPS) break;
      const tokenPrice = o.token === "UP" ? px : r4(1 - px);
      const qty = budget != null ? Math.min(Math.floor((budget / tokenPrice) * 1e6) / 1e6, sz) : Math.min(o.size - o.filled, sz);
      if (qty < 1e-6) continue;
      const fee = takerFee(tokenPrice) * qty;
      o.filled += qty;
      if (budget != null) budget -= qty * tokenPrice;
      out.push({
        id: this.nextFillId++, oid: o.id, win: o.win, t: now, side: o.side, price: px, token: o.token, tokenSide: o.tokenSide, tokenPrice,
        size: budget != null ? qty : Math.round(qty * 100) / 100 || qty, via: "take", queue0: 0, restMs: 0, fv: mark.fv, mid: mark.mid, mk: [null, null, null], settle: null,
        note: `taken at ${cents(tokenPrice)} · fee $${fee.toFixed(3)}`, inv: "", fee,
      });
      if (done()) break;
    }
    if (done()) this.finish(o, "filled", now, null);
    else this.finish(o, "cancelled", now, `fill-and-kill: ${budget != null ? `$${budget.toFixed(2)} of $${o.usd!.toFixed(2)}` : fmtSh(o.size - o.filled)} not available within ${cents(o.tokenPrice)}, cancelled`);
    return out;
  }

  private finish(o: Order, status: "filled" | "cancelled" | "rejected", now: number, note: string | null): void {
    o.status = status;
    o.doneAt = now;
    this.clampT.delete(o.id);
    if (note != null) this.emit({ t: now, win: o.win, oid: o.id, type: status === "rejected" ? "reject" : "cancelled", side: o.side, price: o.price, size: o.size, note, ...evTok(o) });
  }
}

const VIA: Record<FillVia, string> = { queue: "queue (prints at our price passed the queue ahead)", through: "trade-through (a taker printed past our price)", cross: "cross (liquidity rested on our price)", take: "take (we crossed the spread)", live: "live (matched on Polymarket)",
  sweep: "sweep (a taker's sweep reached our price)" };

function active(o: Order): boolean { return o.status === "pending" || o.status === "open" || o.status === "cancelling"; }
function fmtSh(x: number): string { return x >= 1000 ? (x / 1000).toFixed(1) + "k" : x >= 100 || x % 1 === 0 ? x.toFixed(0) : x.toFixed(1); }
function fmtFill(o: Order): string { return `${fmtSh(o.filled)}/${fmtSh(o.size)} filled`; }

/** Real size resting at exactly `price` on our side of the book. */
export function levelSize(book: BookView, side: Side, price: number): number {
  for (const [px, sz] of side === "BUY" ? book.bids : book.asks) if (Math.abs(px - price) < EPS) return sz;
  return 0;
}
