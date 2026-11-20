// Order, fill and event shapes shared by the paper exchange, the order manager, the account and the
// dashboard. The bot BUYS both tokens: an Up bid at p, and a Down bid at q. The two books are mirrors (a
// Down bid at q is the Up ask at 1 − q), so matching runs on the Up book: `side`/`price` are that Up-terms
// view, and `token`/`tokenSide`/`tokenPrice` are the order actually sent. Up + Down pairs merge for $1.
export type Side = "BUY" | "SELL";
export type Token = "UP" | "DOWN";

/** pending = sent, not yet on the book · open = on the book · cancelling = cancel sent, still fillable. */
export type OrderStatus = "pending" | "open" | "cancelling" | "filled" | "cancelled" | "rejected";

export interface Order {
  id: number;
  win: number;              // window startTs (each window is its own market)
  side: Side;               // Up-terms side, for matching on the Up book
  price: number;            // Up-terms price
  token: Token;             // what is sent: a `tokenSide` order for `token` at `tokenPrice`
  tokenSide: Side;
  tokenPrice: number;
  size: number;
  filled: number;
  status: OrderStatus;
  reason: string;           // why the order manager sent it
  createdAt: number;
  ackDue: number;           // goes live (or is rejected) at this time
  liveAt: number | null;
  cancelDue: number | null;
  /** When the cancel was sent (the sweep fill model: a taker that arrived before it reached the venue still fills). */
  cancelAt?: number | null;
  /** Why the order manager cancelled it (the cancel's reason), for Fill.cxlWhy. */
  cancelWhy?: string;
  /** Sweep model: this order's send → at the venue, and its cancel's (PAPER_SWEEP_LAT draws them; else the constants). */
  placeMs?: number;
  cancelMs?: number;
  /** ...drawn while the venue was busy (after a big target move or a sweep that reached our price; PAPER_SWEEP_LAT). */
  placeBusy?: boolean;
  cancelBusy?: boolean;
  /** PAPER_SWEEP_LAT: the quantiles of the two draws, so the race against a taker can resolve them against the swept
   *  tables (venueLatency.ts), and the cancel's wait for the post's answer. */
  placeU?: number;
  cancelU?: number;
  /** PAPER_NEWBEST_LAT: the post set a new best price at its send, so its place time is drawn from the new-best table. */
  placeNewBest?: boolean;
  cancelWait?: number;
  /** Paper: when the venue's cancel answer is heard, so the order manager's pending-order cap stops counting this
   *  order then, as live (PAPER_PENDING_UNTIL=ack). It can still fill from a taker that arrived before the cancel. */
  offAt?: number | null;
  doneAt: number | null;
  /** Shares ahead of us at our price. Starts at the whole level: a new order joins the back. */
  queue: number;
  queue0: number;
  /** Real book size at our price over the last QUEUE_GRACE_MS, newest last. */
  lv: [number, number][];
  /** Resting opposite-side size at or through our price already credited to us. */
  crossUsed: number;
  /** A taker order (fill-and-kill): crosses the spread at its ack, pays the taker fee, the rest is cancelled. */
  take?: boolean;
  /** A take's USDC budget, as the venue runs a market BUY: it spends this at prices up to its limit, so a better price
   *  buys more shares than `size` (2026-10-14: 5 Up ≤ 26¢ filled 5.2 at 25¢). Unset: `size` shares. */
  usd?: number;
}

export type FillVia = "queue" | "through" | "cross" | "take" | "live" | "sweep";

export interface Fill {
  id: number;
  oid: number;
  win: number;
  t: number;
  side: Side;               // Up terms, as on Order
  price: number;
  token: Token;
  tokenSide: Side;
  tokenPrice: number;
  size: number;
  via: FillVia;
  queue0: number;           // queue ahead when the order went live
  restMs: number;           // time on the book before this fill
  fv: number | null;        // model FV at the fill
  mid: number | null;       // book mid at the fill
  /** Mid markout per share at +1 s, +5 s, +30 s, signed so + is good for us; null until known / never if the window closed first. */
  mk: [number | null, number | null, number | null];
  /** Payoff − price per share, signed, once the window settles. */
  settle: number | null;
  /** How the simulator filled it: full/partial, via what, queue, time on the book. */
  note: string;
  /** What the fill did to inventory, e.g. "bought 10 Up → net +35". */
  inv: string;
  /** Taker fee paid on this fill, USDC (0.07 · p(1−p) per share); makers pay none. */
  fee?: number;
  /** Maker fills: true = our cancel was already sent when it filled (cancel in flight), false = the order was resting with
   *  no cancel sent. Unset on takes. The account counts both (WinPos.fillsCxl / fillsNoCxl, the dashboard's row). */
  cxl?: boolean;
  /** Cancel-in-flight fills: what the cancel was (cancelKind: race / replace / jump / other). Unset with no cancel. */
  cxlWhy?: CancelKind;
}

export type CancelKind = "race" | "replace" | "jump" | "other";
/** The order manager's cancel reason, by kind ("race: the level fell…", "replace: target moved…"). */
export const cancelKind = (why: string | undefined): CancelKind =>
  !why ? "other" : /^race\b/.test(why) ? "race" : /^replace\b/.test(why) ? "replace" : /jump/.test(why) ? "jump" : "other";

export type EvType = "place" | "live" | "reject" | "cancel" | "cancelled" | "fill" | "settle" | "info";

export interface OrderEvent {
  seq: number;
  t: number;
  win: number;
  oid: number | null;
  type: EvType;
  side: Side | null;
  price: number | null;
  size: number | null;
  note: string;
  token?: Token | null;
  tokenSide?: Side | null;
  tokenPrice?: number | null;
}

export type Emit = (e: Omit<OrderEvent, "seq">) => void;

export const cents = (x: number) => { const v = Math.round(x * 1000) / 10; return v.toFixed(v % 1 ? 1 : 0) + "¢"; };
export const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
export const EPS = 1e-9;
