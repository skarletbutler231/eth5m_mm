// EXCHANGE — what the trader and the order manager need from a venue: the paper exchange (MM_MODE=paper, simulated on
// the live book) and the live exchange (MM_MODE=live, the real Polymarket CLOB) both implement it, so the quoting and
// order-management code is the same line for line in both modes.
import type { BookView, Print } from "../feeds/pmBook.js";
import type { PlaceReq } from "./paperExchange.js";
import type { Fill, Order } from "./types.js";

export interface Exchange {
  nextId: number;
  nextFillId: number;
  /** The current window's tokens, and its market's condition id (live: where a gone order's trades are looked up). */
  setTokens(up: string | null, down: string | null, cond?: string | null): void;
  /** Every print from the book socket (the paper exchange's tape; the live venue matches by itself). */
  onPrint(p: Print): void;
  place(req: PlaceReq, now: number): Order;
  cancel(o: Order, now: number, why: string): void;
  /** Market closed: every order of that window goes. */
  closeWindow(win: number, now: number): void;
  /** Every working order of every window goes. */
  cancelAll(now: number, why: string): void;
  /** Orders still able to trade (pending, open, cancelling). */
  working(win?: number): Order[];
  /** Working orders plus the ones that just finished, for the dashboard. */
  visible(win: number): Order[];
  /** Advance to `now`; the fills since the last step, not yet booked. `book` is the Up book of `win`. */
  step(now: number, win: number, book: BookView, mark: { fv: number | null; mid: number | null }): Fill[];
  /** A big target move at `now` (the engine's latency detector): the paper venue answers slower for a while
   *  (PAPER_SWEEP_LAT). The live venue is as slow as it is. */
  noteMove?(now: number): void;
  /** Live: fills heard on the user channel or post answers not yet taken in by step() (the account and the order's queue
   *  lag them until the next step). The paper venue only makes fills inside step(): none. */
  unsynced?(): boolean;
}
