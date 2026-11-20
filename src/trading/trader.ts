// TRADER — the engine's single handle on trading: paper exchange + order manager + account, persistence,
// the order/fill event stream and the dashboard block. Per frame the engine calls
//   pre()   advance the paper exchange to now, book fills into inventory, mark, measure markouts
//   (the engine quotes with the inventory from position())
//   post()  hand the target quote to the order manager
// and on the window lifecycle closeWindow() at the roll and settle() when a label arrives.
//
// State: data/paper/state.json (cash, ids, every unsettled window, the equity history), rewritten at most
// once a second after a change, on every settlement and at shutdown. reset() (the dashboard's button, or
// deleting the file with the bot stopped) starts a fresh account. resetPnl() (the dashboard's reset PnL, paper or live)
// keeps the account and restarts its PnL at zero. syncWallet() (live, the dashboard's sync to wallet) books the wallet's
// collateral minus the booked cash as a deposit or withdrawal: cash and start move together, PnL stays. Orders are not persisted: a restart cancels them, which is what a
// real restart does too.
//
// MM_MODE=live (REAL MONEY): the same order manager and account drive the live exchange (liveExchange.ts) on the real
// CLOB; state goes to data/<DATA_DIR>/live/state.json and a new account starts at the wallet's balance. On top:
//   · loss limit   PnL ≤ −LIVE_MAX_LOSS cancels every order and sends no more (it stays stopped across restarts);
//                  the dashboard's reset PnL lifts it at once (PnL restarts at 0, the limit counts from there);
//                  LIVE_LOSS_ON=settled counts only labelled windows (the open one's mark does not trip it)
//   · blind        no new orders while the user channel is down (fills would go unseen); working ones are cancelled
//   · rate guard   more than LIVE_MAX_PLACES_10S orders in 10 s pauses placing for 10 s
//   · balance      orders are sized against the lower of the booked cash and the wallet's real collateral
//   · wallet check every 15 s the wallet's Up and Down tokens of the live window are compared with what the account
//                  says it bought: more in the wallet than booked (by over 1 share, twice running) means fills went
//                  unseen, and it stops as at the loss limit (another bot trading the same window would trip it too,
//                  unless LIVE_PEER_STATE names its state.json: its booked tokens then count, peers.ts)
//   · chain        a window's Up+Down pairs are merged on chain at its close, and what it still holds is redeemed once
//                  it is labelled (one gasless transaction each, retried with a backoff while the market resolves on
//                  chain; the jobs survive a restart). Only with LIVE_CHAIN=on (off by default since 2026-11-13:
//                  Polymarket redeems settled positions itself).
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { CFG } from "../config.js";
import { stopReason } from "../control.js";
import type { BookView, PmBookFeed } from "../feeds/pmBook.js";
import { windowName, type Quote } from "../quoter.js";
import type { Take } from "../taker.js";
import type { Store } from "../store.js";
import { utcDate } from "../store.js";
import { Account, newPos, sideSign, type PaperSummary, type WinPos } from "./account.js";
import type { Exchange } from "./exchange.js";
import { LiveExchange, median } from "./liveExchange.js";
import { OrderManager, reserveOf, type Action, type RaceCfg } from "./orderManager.js";
import { PaperExchange } from "./paperExchange.js";
import { peerHeld } from "./peers.js";
import { cents, type Fill, type Order, type OrderEvent, type Token } from "./types.js";
import type { Venue } from "./venue.js";

interface WinLog { events: OrderEvent[]; fills: Fill[] }

export interface PaperAgg {
  windows: number; traded: number; won: number; lost: number;
  pnl: number; fills: number; bought: number; sold: number; notional: number;
  /** Maker fills with our cancel in flight · with no cancel sent (windows recorded since 2026-11-10 only). */
  fillsCxl: number; fillsNoCxl: number;
  edge: number; edgeN: number; mk: [number, number, number]; mkN: [number, number, number];
  best: number | null; worst: number | null; placed: number; cancelled: number; rejected: number;
  pairs: number; pairCost: number; fees: number;
  /** Maker rebates credited (PAPER_MAKER_REBATE of the taker fee on maker fills). */
  rebate: number;
}

const EV_RING = 600, EV_HELLO = 300, WIN_EV_CAP = 6000, EQ_CAP = 5000;

/** An on-chain step of a live window: merge its pairs at the close, redeem it once Gamma has the final label. */
interface ChainJob { win: number; cond: string; kind: "merge" | "redeem"; tries: number; next: number; pairs?: number }
const CHAIN_MAX_TRIES = 12;
const REDEEM_DELAY_MS = 60_000;
/** LIVE_CHAIN off: how long after a window's close the wallet sync waits for Polymarket's own redeem (seen 60–388 s),
 *  when the window's token ids were not saved. */
const AUTO_REDEEM_WAIT_MS = 600_000;
const hhmm = (win: number) => new Date(win * 1000).toISOString().slice(11, 16);

export class Trader {
  readonly mode = CFG.mode;
  /** paper or live: orders go to an exchange (shadow only draws the quote). */
  readonly trading = CFG.mode !== "shadow";
  acct: Account;
  private readonly ex: Exchange;
  private readonly live: LiveExchange | null = null;
  /** live: the wallet's collateral as last read (null = not yet). */
  private venueBal: number | null = null;
  /** live: why no orders go out any more (the loss limit); null = trading. */
  private halted: string | null = null;
  /** Orders can go out: trading mode and (live) not stopped at the loss limit, the wallet check or shutdown. */
  get active(): boolean { return this.trading && this.halted == null; }
  /** live: the stop is the loss limit's (a PnL reset lifts it); the wallet check's and shutdown's need a restart. */
  private lossHalt = false;
  /** When the last fill was booked (ms): the wallet sees it only once the match settles on chain. */
  private lastFillAt = 0;
  private pauseUntil = 0;
  private places: number[] = [];
  private chain: ChainJob[] = [];
  private chainBusy = false;
  /** live: the window being traded and its tokens, for the wallet check; how many checks in a row found too much. */
  private cur: { win: number; up: string; down: string } | null = null;
  private walletOver = 0;
  private readonly oms: OrderManager;
  private readonly file: string;
  private ev: OrderEvent[] = [];
  private seq = 0;
  private sentSeq = 0;
  private logs = new Map<number, WinLog>();
  private actions: Action[] = [];
  private dirty = false;
  private lastSave = 0;
  private fillsVer = 0; private sentFillsVer = -1;
  private eqVer = 0; private sentEqVer = -1;
  /** Settled windows of this account: today, all time, and by quoting setup (windows that recorded one). */
  private settledAgg: { date: string; today: PaperAgg; all: PaperAgg; ab: Record<string, PaperAgg> } | null = null;
  /** The account's first window: aggregates skip index entries from an earlier account. */
  private since: number;
  /** Windows before `since` that a PnL reset carried on (still unsettled then): they count from the reset. */
  private carry: number[] = [];
  /** The window in progress at boot. */
  private readonly bootWin = Math.floor(Date.now() / 1000 / 300) * 300;
  /** Equity after each settlement, [ms, USDC], from the account's start. */
  private eq: [number, number][] = [];
  /** Windows that stopped market making (lock.ts, MM_LOCK_PCT), and why: no maker orders, only the lock's takes. */
  private stopped = new Map<number, string>();
  /** When the last flow take (v4) was sent, for its cooldown. */
  private lastFlow: { win: number; t: number } | null = null;

  /** venue + balance: MM_MODE=live, the connected venue and the wallet's collateral at boot (a new account starts there). */
  constructor(pm: PmBookFeed, private readonly store: Store, private readonly log: (m: string) => void, dataDir: string,
              private readonly venue: Venue | null = null, liveStart: number | null = null) {
    if (this.mode === "live" && !venue) throw new Error("MM_MODE=live needs a connected venue");
    this.file = path.join(dataDir, this.mode === "live" ? "live" : "paper", "state.json");
    let st: any = null;
    try { if (fs.existsSync(this.file)) st = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch (e) {
      if (this.mode === "live") throw new Error(`live state.json unreadable (${(e as Error).message}): fix or move it; a live account is not restarted silently`);
      this.log(`[paper] state.json unreadable (${(e as Error).message}); starting a fresh account`);
    }
    const start0 = this.mode === "live" ? liveStart ?? 0 : CFG.paperStartUsdc;
    this.acct = new Account(st?.start ?? start0, st?.cash ?? start0, CFG.paperMakerRebate);
    this.venueBal = liveStart;
    this.chain = venue?.gasless && CFG.liveChain ? st?.chain ?? [] : [];
    if (this.mode === "live" && !CFG.liveChain && st?.chain?.length)
      log(`[live] LIVE_CHAIN off: ${st.chain.length} saved merge/redeem job(s) dropped (Polymarket redeems settled windows itself)`);
    const curSt = Math.floor(Date.now() / 1000 / 300) * 300;
    this.since = st?.since ?? curSt;
    this.carry = st?.carry ?? [];
    for (const w of st?.wins ?? []) {
      this.acct.wins.set(w.win, { ...newPos(w.win, w.endTs), ...w });
      if (w.win < curSt) this.acct.close(w.win);        // down across the window's close: it is over
    }
    if (this.mode === "live") {
      const lx = new LiveExchange(venue!, (e) => this.onEvent(e), log, st?.nextOid ?? 1, st?.nextFid ?? 1, Date.now, CFG.liveEarlyCancel, CFG.cancelDelayMs);
      this.live = lx; this.ex = lx;
      pm.setOwn((a) => lx.own(a));       // the strategy sees the book without our own orders, as on paper
      // the orders the last run left on the book (saved each second): exactly those, other bots share the wallet
      const left: string[] = st?.open ?? [];
      if (left.length) venue!.cancelMany(left).then((n) => log(`[live] ${n} of ${left.length} order(s) from the last run cancelled`),
        (e) => log(`[live] ⚠ cancelling the last run's ${left.length} order(s) failed (${(e as Error).message}): check polymarket.com`));
    } else {
      this.ex = new PaperExchange(CFG.paperLatencyMs, (e) => this.onEvent(e), st?.nextOid ?? 1, st?.nextFid ?? 1,
        (win) => this.acct.wins.get(win)?.up ?? 0, CFG.paperTakerDelayMs, CFG.paperFillModel === "sweep" ? CFG.paperSweep : null, CFG.paperTakeMs, CFG.paperTakeLive, CFG.cancelDelayMs);
    }
    this.oms = new OrderManager(this.ex, CFG.requoteMinMs, { ticks: CFG.tolerateTicks, edge: CFG.tolerateEdge, stayAtTouch: CFG.stayAtTouch });
    pm.onPrint((p) => { if (this.mode === "paper") this.ex.onPrint(p); });
    if (this.trading) {
      const unsettled = [...this.acct.wins.values()].filter((p) => p.state !== "settled");
      this.log(`[${this.mode}] account: cash $${this.acct.cash.toFixed(2)} of $${this.acct.start.toFixed(2)} start` +
        (unsettled.length ? `, ${unsettled.length} window(s) still holding inventory` : "") + (st ? "" : " (new)") +
        (this.mode === "live" ? ` · wallet ${venue!.wallet} holds $${(liveStart ?? 0).toFixed(2)} · loss limit −$${CFG.liveMaxLoss}` +
          (this.chain.length ? ` · ${this.chain.length} on-chain job(s) resumed` : "") : ""));
    } else {
      this.log("[paper] MM_MODE=shadow: quotes are computed and drawn, no orders are simulated");
    }
    this.eq = st?.eq ?? this.seedEquity();
    this.recomputeAgg();
    if (this.mode === "live") {
      this.checkLoss(Date.now());
      setInterval(() => { venue!.balance().then((b) => { this.venueBal = b; }, (e) => this.log(`[live] balance: ${(e as Error).message}`)); }, 5000).unref();
      setInterval(() => { void this.runChain(); }, 5000).unref();
      setInterval(() => { void this.walletCheck(); }, 15_000).unref();
      // this process's event-loop stalls over the minute: a late callback delays every answer and event it handles
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      setInterval(() => {
        const lx = this.live!, ms = (ns: number) => Math.round(ns / 1e6);
        this.log(`[live] cash $${this.acct.cash.toFixed(2)} · wallet $${this.venueBal?.toFixed(2) ?? "?"} · PnL ${usd(this.acct.equity() - this.acct.start)} · ` +
          (CFG.liveLossOn === "settled" ? `settled ${usd(this.settledPnl())} · ` : "") + `post ${median(lx.lat.post) ?? "?"} ms (sign ${median(lx.lat.sign) ?? "?"}) · cancel ${median(lx.lat.cancel) ?? "?"} ms (medians) · ` +
          `event loop p99 ${ms(loop.percentile(99))} ms, max ${ms(loop.max)} · user channel ${venue!.connected() ? "up" : "DOWN"}` +
          (this.chain.length ? ` · ${this.chain.length} on-chain job(s) queued` : "") + (this.halted ? " · STOPPED" : ""));
        loop.reset();
      }, 60_000).unref();
    }
  }

  /** An account saved before the equity history existed: rebuild it from the settled windows in the index. */
  private seedEquity(): [number, number][] {
    const out: [number, number][] = [[this.since * 1000, this.acct.start]];
    const rows = this.store.entries().filter((e) => e.paper?.settled && e.startTs >= this.since).sort((a, b) => a.startTs - b.startTs);
    let v = this.acct.start;
    for (const e of rows) out.push([(e.startTs + 300) * 1000 + 2000, (v += e.paper!.pnl)]);
    return out;
  }

  /** Start a fresh account: every order cancelled, all inventory dropped, PnL and history restart. Paper only (false). */
  reset(start: number, curWin: number, now: number): boolean {
    if (this.mode !== "paper") return false;
    const before = this.acct.equity();
    this.ex.cancelAll(now, "account reset");
    this.acct = new Account(start, start, CFG.paperMakerRebate);
    this.since = curWin;
    this.carry = [];
    this.logs = new Map();
    this.eq = [[now, start]];
    this.onEvent({ t: now, win: curWin, oid: null, type: "info", side: null, price: null, size: null,
      note: `paper account reset: equity $${before.toFixed(2)} → $${start.toFixed(2)} · orders cancelled, inventory cleared, PnL restarts` });
    this.log(`[paper] account reset from the dashboard: equity $${before.toFixed(2)} → $${start.toFixed(2)}`);
    this.fillsVer++;
    this.recomputeAgg();
    this.save();
    return true;
  }

  /** PnL restarts at zero from now, paper or live: cash, inventory, orders and fills stay (Account.rebase), the equity
   *  history and the stats count from here. Live, the loss limit counts from here too, and a loss-limit stop is lifted:
   *  quoting resumes on the next frame (a wallet-check stop stays until a restart). */
  resetPnl(curWin: number, now: number): boolean {
    if (!this.trading) return false;
    const before = this.acct.equity() - this.acct.start;
    const held = this.acct.rebase();
    const resumed = this.mode === "live" && this.lossHalt && this.halted != null;
    if (resumed) { this.halted = null; this.lossHalt = false; }
    this.since = curWin;
    this.carry = held.map((h) => h.win).filter((w) => w < curWin);
    this.eq = [[now, this.acct.start]];
    const carried = held.filter((h) => Math.abs(h.pnl) > 0.005)
      .map((h) => `${new Date(h.win * 1000).toISOString().slice(11, 16)} UTC ${usd(h.pnl)}`);
    const note = `PnL reset: ${usd(before)} → $0 at equity $${this.acct.start.toFixed(2)} · cash, inventory and orders kept` +
      (carried.length ? ` · open window PnL so far zeroed (${carried.join(", ")}), held inventory carried at its mark` : "") +
      (this.mode === "live" ? ` · the loss limit −$${CFG.liveMaxLoss} counts from here${resumed ? " · loss-limit stop lifted, trading resumes" : this.halted ? " (still STOPPED: restart to resume)" : ""}` : "");
    this.onEvent({ t: now, win: curWin, oid: null, type: "info", side: null, price: null, size: null, note });
    this.log(`[${this.mode}] ${note}`);
    this.recomputeAgg();
    this.save();
    return true;
  }

  /** live: why the booked cash cannot be compared with the wallet's USDC right now (null = it can). The account books
   *  a pair's $1 at once and a payout at the label; the wallet gets them only from the on-chain merge (at the close)
   *  and redeem, and a fill only once its match settles on chain. */
  private syncBlock(now: number): string | null {
    if (this.chain.length) return `${this.chain.length} on-chain merge/redeem job(s) still queued: the wallet has not been paid for them yet, try after they finish`;
    // no jobs of our own: Polymarket redeems a traded window itself once it resolves (seen 60–388 s after the close).
    // An unlabelled one blocks for an hour at most, so a label that never comes can't block the sync for good.
    const unlabelled = [...this.acct.wins.values()].find((p) => p.state === "settling" && p.fills > 0 && now - p.endTs * 1000 < 3_600_000);
    if (unlabelled) return `the ${hhmm(unlabelled.win)} UTC window has no label yet: Polymarket has not redeemed it into the wallet, try in a few minutes`;
    const pend = [...this.acct.wins.values()].find((p) => p.state === "open" && p.pairs > 0);
    if (pend) return `the open window has ${+pend.pairs.toFixed(2)} Up+Down pair(s) booked as cash that the wallet is paid only after its close: try after the close`;
    if (now - this.lastFillAt < 30_000) return "a fill in the last 30 s may not have settled on chain yet: try again in a moment";
    return null;
  }

  /** live, LIVE_CHAIN off: a settled window of the last hour whose winning tokens are still in the wallet (Polymarket
   *  has not redeemed it yet, so its payout is booked but not paid). Losing tokens stay in the wallet after the redeem,
   *  so only the winning side counts. A window without saved token ids (traded before 2026-11-13's fix) waits
   *  AUTO_REDEEM_WAIT_MS after its close instead. */
  private async redeemBlock(now: number): Promise<string | null> {
    if (this.chain.length || CFG.liveChain) return null;
    for (const p of this.acct.wins.values()) {
      if (p.state !== "settled" || !p.fills || p.outcome == null || now - p.endTs * 1000 >= 3_600_000) continue;
      const tok = p.outcome ? p.upTok : p.downTok;
      const why = `the ${hhmm(p.win)} UTC window settled but Polymarket has not redeemed it into the wallet yet (it does ~1–6 min after the close): try in a few minutes`;
      if (!tok) { if (now - p.endTs * 1000 < AUTO_REDEEM_WAIT_MS) return why; continue; }
      try { if (await this.venue!.tokenBalance(tok) > 0.01) return why; }
      catch (e) { return `reading the wallet's tokens of the ${hhmm(p.win)} UTC window failed (${(e as Error).message}): try again`; }
    }
    return null;
  }

  /** live: the wallet's collateral now, and what a sync would book (for the dashboard's confirmation). */
  async walletGap(): Promise<{ wallet: number; cash: number; d: number; block: string | null } | null> {
    if (this.mode !== "live") return null;
    const wallet = await this.venue!.balance();
    this.venueBal = wallet;
    const now = Date.now();
    return { wallet, cash: this.acct.cash, d: wallet - this.acct.cash, block: this.syncBlock(now) ?? await this.redeemBlock(now) };
  }

  /** live: book (wallet's collateral − booked cash) as a deposit (or a withdrawal when negative): cash and start move by
   *  it together, so PnL, the loss limit and the stats are unchanged and the equity curve is shifted by it. Refused while
   *  the two cannot be compared (syncBlock). Anything else that trades from the wallet is absorbed into the deposit,
   *  and so is the maker rebate booked at the fills but not yet paid (it is paid once a day). */
  async syncWallet(): Promise<{ ok: true; d: number; before: number; wallet: number } | { ok: false; error: string }> {
    if (this.mode !== "live") return { ok: false, error: `MM_MODE=${this.mode}: only a live account syncs to its wallet` };
    let why = this.syncBlock(Date.now()) ?? await this.redeemBlock(Date.now());
    if (why) return { ok: false, error: why };
    let wallet: number;
    try { wallet = await this.venue!.balance(); }
    catch (e) { return { ok: false, error: `reading the wallet's balance failed: ${(e as Error).message}` }; }
    why = this.syncBlock(Date.now());               // a fill may have come in while the balance was read
    if (why) return { ok: false, error: why };
    this.venueBal = wallet;
    const before = this.acct.cash, d = wallet - before, now = Date.now();
    this.acct.cash += d;
    this.acct.start += d;
    this.eq = this.eq.map(([t, v]) => [t, v + d]);
    const note = `synced to the wallet: cash $${before.toFixed(2)} → $${wallet.toFixed(2)} (${usd(d)} booked as a ${d >= 0 ? "deposit" : "withdrawal"}) · PnL unchanged`;
    this.onEvent({ t: now, win: Math.floor(now / 1000 / 300) * 300, oid: null, type: "info", side: null, price: null, size: null, note });
    this.log(`[live] ${note}`);
    this.save();
    return { ok: true, d, before, wallet };
  }

  /** Every fill as it is booked (the engine's fill signal, signal.ts). */
  onFill: ((f: Fill) => void) | null = null;

  // ---- per frame -------------------------------------------------------------------------------
  pre(c: { now: number; win: number; endTs: number; up: string | null; down: string | null; cond?: string | null; book: BookView; fv: number | null; mid: number | null }): void {
    if (!this.trading) return;
    const cur = this.acct.pos(c.win, c.endTs);
    if (c.cond && !cur.cond) cur.cond = c.cond;
    if (c.up && c.down && !cur.upTok) { cur.upTok = c.up; cur.downTok = c.down; }
    if (c.up && c.down && this.cur?.win !== c.win) { this.cur = { win: c.win, up: c.up, down: c.down }; this.walletOver = 0; }
    this.ex.setTokens(c.up, c.down, c.cond);
    for (const f of this.ex.step(c.now, c.win, c.book, { fv: c.fv, mid: c.mid })) {
      const st = this.acct.wins.get(f.win)?.state;
      if (this.mode === "live" && st === "settled") this.log(`[live] ⚠ #${f.oid} filled ${f.size} after window ${f.win} settled: the account misses it, the wallet has it`);
      f.inv = this.acct.apply(f);
      this.lastFillAt = Date.now();
      if (f.token === "UP" && f.tokenSide === "SELL" && / Down @ /.test(f.inv)) this.log(`[paper] ⚠ #${f.oid} sold more Up than held, booked as a Down buy: ${f.inv}`);
      this.winLog(f.win).fills.push(f);
      if (this.onFill) { try { this.onFill(f); } catch { /* */ } }
      this.onEvent({ t: f.t, win: f.win, oid: f.oid, type: "fill", side: f.side, price: f.price, size: f.size, note: `${f.note} · ${f.inv}`,
        token: f.token, tokenSide: f.tokenSide, tokenPrice: f.tokenPrice });
      this.fillsVer++; this.dirty = true;
    }
    if (this.acct.mark(c.win, c.mid, c.fv, c.now)) this.fillsVer++;
    if (this.mode === "live") this.checkLoss(c.now);
    if (this.dirty && c.now - this.lastSave >= 1000) this.save();
  }

  /** PnL of the labelled windows only: equity − start without the windows still open or awaiting their label. */
  settledPnl(): number {
    let v = this.acct.cash - this.acct.start;
    for (const p of this.acct.wins.values()) if (p.state !== "settled") v -= p.cash;
    return v;
  }

  /** live: the loss limit. LIVE_LOSS_ON=mark (default): marked at the mid, so a sharp move against open inventory can trip
   *  it. settled: only labelled windows count, so it trips at a window's label, never inside one. */
  private checkLoss(now: number): void {
    const settled = CFG.liveLossOn === "settled";
    const pnl = settled ? this.settledPnl() : this.acct.equity() - this.acct.start;
    if (this.halted || pnl > -CFG.liveMaxLoss) return;
    this.halted = `live STOPPED: ${settled ? "settled " : ""}PnL ${usd(pnl)} reached the loss limit −$${CFG.liveMaxLoss} (LIVE_MAX_LOSS${settled ? ", LIVE_LOSS_ON=settled" : ""}); reset PnL on the dashboard to resume`;
    this.lossHalt = true;
    this.log(`[live] ⛔ ${this.halted}`);
    this.ex.cancelAll(now, "loss limit");
    this.onEvent({ t: now, win: Math.floor(now / 1000 / 300) * 300, oid: null, type: "info", side: null, price: null, size: null, note: this.halted });
  }

  /** live: the wallet holds what the account booked? Pairs stay in the wallet until the merge at the close. */
  private async walletCheck(): Promise<void> {
    const c = this.cur, p = c ? this.acct.wins.get(c.win) : undefined;
    if (!c || !p || p.state !== "open" || this.halted) return;
    try {
      const [wu, wd] = await Promise.all([this.venue!.tokenBalance(c.up), this.venue!.tokenBalance(c.down)]);
      if (this.cur?.win !== c.win || p.state !== "open") return;
      // another bot on the wallet (LIVE_PEER_STATE): its booked tokens of the window count too; skip while it is mid-change
      const peer = CFG.livePeerState.length ? await peerHeld(CFG.livePeerState, [c.up, c.down], Date.now(), this.log) : null;
      if (peer?.quiet) return;
      const pu = peer?.held[0] ?? 0, pd = peer?.held[1] ?? 0;
      const eu = p.up + p.pairs + pu, ed = p.down + p.pairs + pd;
      if (wu > eu + 1 || wd > ed + 1) {
        if (++this.walletOver < 2) return;
        this.halted = `live STOPPED: the wallet holds ${wu.toFixed(2)} Up / ${wd.toFixed(2)} Down of this window, the account booked ${eu.toFixed(2)} / ${ed.toFixed(2)}` +
          (peer?.peers ? ` (${pu.toFixed(2)} / ${pd.toFixed(2)} of it the other bot's on the wallet)` : "") + ": " +
          "fills went unseen (or another bot traded this window); check polymarket.com, then restart";
        this.log(`[live] ⛔ ${this.halted}`);
        this.ex.cancelAll(Date.now(), "wallet check");
        this.onEvent({ t: Date.now(), win: c.win, oid: null, type: "info", side: null, price: null, size: null, note: this.halted });
      } else this.walletOver = 0;
    } catch (e) { this.log(`[live] wallet check: ${(e as Error).message}`); }
  }

  /** live: why nothing may be placed now (null = go). */
  private liveBlock(now: number): string | null {
    if (this.halted) return this.halted;
    if (!this.venue!.connected()) return "live: the user channel is down, no orders until it is back (fills would go unseen)";
    if (now < this.pauseUntil) return `live: order-rate guard (over ${CFG.liveMaxPlaces10s} orders in 10 s), placing resumes in ${Math.ceil((this.pauseUntil - now) / 1000)} s`;
    return null;
  }

  /** The dashboard's STOP (control.ts): every working order cancelled now, not at the next frame; logged on the blotter. */
  stopOrders(now: number, why: string): void {
    if (!this.trading) return;
    this.ex.cancelAll(now, why);
    this.onEvent({ t: now, win: Math.floor(now / 1000 / 300) * 300, oid: null, type: "info", side: null, price: null, size: null, note: why });
  }

  /** live, at shutdown: no more orders, every open one on the account cancelled. */
  async stop(): Promise<void> {
    if (this.mode !== "live") return;
    this.halted ??= "shutting down";
    this.ex.cancelAll(Date.now(), "shutting down");
    const ids = this.live!.openIds();
    try {
      const n = await Promise.race([this.venue!.cancelMany(ids), new Promise<number>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
      this.log(`[live] shutdown: ${n} of ${ids.length} open order(s) cancelled on the venue`);
    } catch (e) { this.log(`[live] ⚠ shutdown cancel failed (${(e as Error).message}): ${ids.length} order(s) may still rest, check polymarket.com`); }
    this.save();
  }

  /** Net Up shares, both legs, each leg's average cost (null when not held), and the pairs merged so far with their cost. */
  position(win: number): { net: number; up: number; down: number; avgUp: number | null; avgDown: number | null; pairs: number; pairCost: number } {
    const p = this.acct.wins.get(win);
    if (!p) return { net: 0, up: 0, down: 0, avgUp: null, avgDown: null, pairs: 0, pairCost: 0 };
    return { net: p.up - p.down, up: p.up, down: p.down, avgUp: p.up > 1e-9 ? p.upCost / p.up : null, avgDown: p.down > 1e-9 ? p.downCost / p.down : null,
      pairs: p.pairs, pairCost: p.pairCost };
  }

  /** mkt: the tick and the Up book's best bid / ask, for the order manager's queue-retention rules; the Up book and the
   *  queue-race settings (v4) for its race rules.
   *  take (v4; excess.ts also between frames): a fill-and-kill BUY sent first, so the maker orders are placed against what it leaves free.
   *  fast: a decision between frames (MM_DECIDE_STEP_MS); it shows on the dashboard only when it placed, replaced or
   *  cancelled something, so the frame's own row is not overwritten by a hundred "keep"s a second. */
  post(win: number, q: Quote, now: number, minSize: number,
       mkt: { tick: number; bestBid: number | null; bestAsk: number | null; book?: BookView | null; race?: RaceCfg | null } = { tick: 0.01, bestBid: null, bestAsk: null },
       take: Take | null = null, fast = false): void {
    if (!this.trading) return;
    this.acct.pos(win);
    // the dashboard's STOP (control.ts): nothing goes out, paper or live, the lock's takes included
    const halt = stopReason();
    if (halt) {
      for (const o of this.ex.working(win)) this.ex.cancel(o, now, halt);
      this.actions = [{ side: "up", act: "idle", note: halt }, { side: "down", act: "idle", note: halt }];
      return;
    }
    if (this.mode === "live") {
      const stop = this.liveBlock(now);
      if (stop) {
        for (const o of this.ex.working(win)) this.ex.cancel(o, now, stop);
        this.actions = [{ side: "up", act: "idle", note: stop }, { side: "down", act: "idle", note: stop }];
        return;
      }
    }
    const acts: Action[] = [];
    const stop = this.stopped.get(win);
    if (stop) {
      // lock.ts: market making is over for this window; only the lock's take may still go
      for (const o of this.ex.working(win)) if (!o.take) this.ex.cancel(o, now, stop);
      if (take) {
        const o = this.ex.place({ win, token: take.token, side: "BUY", price: take.price, size: take.size, reason: take.why, take: true,
          ...(take.usd != null ? { usd: take.usd } : {}) }, now);
        acts.push({ side: take.token === "UP" ? "up" : "down", act: "take", note: `#${o.id} ${take.size} ${take.token === "UP" ? "Up" : "Down"} @ ${cents(take.price)} · ${take.kind}, fill-and-kill` });
      }
      if (!fast || take) this.actions = [...acts, { side: "up", act: "idle", note: stop }, { side: "down", act: "idle", note: stop }];
      return;
    }
    if (take) {
      const o = this.ex.place({ win, token: take.token, side: "BUY", price: take.price, size: take.size, reason: take.why, take: true,
        ...(take.usd != null ? { usd: take.usd } : {}) }, now);
      if (take.kind === "flow") this.lastFlow = { win, t: now };
      acts.push({ side: take.token === "UP" ? "up" : "down", act: "take", note: `#${o.id} ${take.size} ${take.token === "UP" ? "Up" : "Down"} @ ${cents(take.price)} · ${take.kind}, fill-and-kill` });
    }
    const synced = this.oms.sync(win, q, now, { free: this.free(), minSize, ...mkt,
      cap: CFG.capPending ? { net: this.position(win).net, max: q.cap ?? CFG.maxPosition } : null });
    if (!fast || take || synced.some((a) => a.act === "place" || a.act === "replace" || a.act === "cancel")) this.actions = [...acts, ...synced];
  }

  /** lock.ts: the window stops market making (its maker orders are cancelled at the next post). Logged once. */
  stopWindow(win: number, why: string, now: number): void {
    if (!this.trading || this.stopped.has(win)) return;
    this.stopped.set(win, why);
    for (const k of this.stopped.keys()) if (k < win - 3600) this.stopped.delete(k);
    this.onEvent({ t: now, win, oid: null, type: "info", side: null, price: null, size: null, note: why });
    this.log(`[${this.mode}] ${win} ${why}`);
  }

  /** The window's holdings after merges, its cash flow so far and its fill count (lock.ts). */
  winBook(win: number): { up: number; down: number; cash: number; fills: number; upAvg: number | null; downAvg: number | null } {
    const p = this.acct.wins.get(win);
    return p ? { up: p.up, down: p.down, cash: p.cash, fills: p.fills, upAvg: p.up > 1e-9 ? p.upCost / p.up : null, downAvg: p.down > 1e-9 ? p.downCost / p.down : null }
      : { up: 0, down: 0, cash: 0, fills: 0, upAvg: null, downAvg: null };
  }

  /** A taker BUY (fill-and-kill) sent now, outside the frame's quote: the pair trade's legs. usd: its USDC budget (it
   *  buys what that pays for at prices up to `price`, as the venue's market BUY). null = nothing may go out (shadow; live
   *  and stopped, blind or rate-paused). */
  take(win: number, token: Token, price: number, size: number, why: string, now: number, usd?: number): Order | null {
    if (!this.trading || stopReason() || (this.mode === "live" && this.liveBlock(now))) return null;
    this.acct.pos(win);
    return this.ex.place({ win, token, side: "BUY", price, size, reason: why, take: true, ...(usd != null ? { usd } : {}) }, now);
  }

  /** A post-only BUY sent now, outside the frame's quote: the pair trade's maker leg 1. null = nothing may go out. */
  bid(win: number, token: Token, price: number, size: number, why: string, now: number): Order | null {
    if (!this.trading || stopReason() || (this.mode === "live" && this.liveBlock(now))) return null;
    this.acct.pos(win);
    return this.ex.place({ win, token, side: "BUY", price, size, reason: why }, now);
  }

  /** Cancel one order (the pair trade's maker leg 1, at the end of its life). */
  cancel(o: Order, now: number, why: string): void { this.ex.cancel(o, now, why); }

  /** MM_RACE_ON_BOOK: the window has a bid the race exits watch (orderManager.raceable). */
  raceable(win: number): boolean { return this.trading && this.oms.raceable(win); }

  /** MM_RACE_ON_BOOK: the race exits alone on a book update (orderManager.raceOnly: cancels only). Cancels are always
   *  allowed, live too (a blocked live account still cancels). The rows replace that side's on the dashboard. */
  raceCheck(win: number, now: number, book: BookView, race: RaceCfg): void {
    if (!this.trading) return;
    const acts = this.oms.raceOnly(win, now, book, race);
    if (acts.length) this.actions = [...this.actions.filter((a) => !acts.some((x) => x.side === a.side)), ...acts];
  }

  /** A big target move (the engine's latency detector): the paper venue is slow for a while (PAPER_SWEEP_LAT). */
  noteMove(now: number): void { this.ex.noteMove?.(now); }

  /** What one order of the window filled so far: shares, their average token price and the fees paid. */
  fillsOf(win: number, oid: number): { qty: number; px: number | null; fee: number } {
    let qty = 0, cost = 0, fee = 0;
    for (const f of this.logs.get(win)?.fills ?? []) if (f.oid === oid) { qty += f.size; cost += f.tokenPrice * f.size; fee += f.fee ?? 0; }
    return { qty, px: qty > 1e-9 ? cost / qty : null, fee };
  }

  /** The dashboard's order-manager rows, when the quote does not go to the order manager (the pair trade). */
  show(actions: Action[]): void { this.actions = actions; }

  /** USDC not locked by working orders. Live: of the lower of the booked cash and the wallet (a merge or redeem the
   *  account has booked may not have landed on chain yet). */
  /** Live: fills or post answers the exchange heard that the next pre() books (MM_DECIDE_EVENTS steps wait for it). */
  unsynced(): boolean { return this.ex.unsynced?.() ?? false; }

  free(): number {
    const cash = this.mode === "live" && this.venueBal != null ? Math.min(this.acct.cash, this.venueBal) : this.acct.cash;
    return cash - this.reserved();
  }

  /** The token a take of this window is buying while it is still on its way to the book (null = none). */
  takeInFlight(win: number): Token | null {
    if (!this.trading) return null;
    for (const o of this.ex.working(win)) if (o.take && o.liveAt == null) return o.token;
    return null;
  }

  /** Milliseconds since the last flow take of this window was sent (null = none yet). */
  sinceFlowTake(win: number, now: number): number | null {
    return this.lastFlow?.win === win ? now - this.lastFlow.t : null;
  }

  /** Which sides have a working maker order (placed or on the book, not being cancelled), for the quoter's dead band. */
  workingSides(win: number): { bid: boolean; ask: boolean } {
    let bid = false, ask = false;
    if (!this.trading) return { bid, ask };
    for (const o of this.ex.working(win)) {
      if (o.status === "cancelling" || o.take) continue;
      if (o.side === "BUY") bid = true; else ask = true;
    }
    return { bid, ask };
  }

  /** Live (on-book) order prices and the net position, for the recorded row. */
  rowCols(win: number): [number | null, number | null, number] {
    let wb: number | null = null, wa: number | null = null;
    for (const o of this.ex.working(win)) {
      if (o.liveAt == null || o.take) continue;
      if (o.side === "BUY") wb = wb == null ? o.price : Math.max(wb, o.price);
      else wa = wa == null ? o.price : Math.min(wa, o.price);
    }
    return [wb, wa, this.position(win).net];
  }

  /** USDC locked by the working orders (each a BUY of Up or Down at its own price). */
  private reserved(): number {
    let r = 0;
    for (const o of this.ex.working()) r += reserveOf(o.tokenSide, o.tokenPrice, o.size - o.filled);
    return r;
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  /** The window ended: its market is closed, so every order goes and the inventory waits for the label. */
  closeWindow(win: number, now: number): void {
    if (!this.trading) return;
    this.ex.closeWindow(win, now);
    const p = this.acct.wins.get(win);
    if (!p) return;
    this.acct.close(win);
    if (this.mode === "live" && p.pairs > 1e-9 && p.cond) this.queueChain(win, p.cond, "merge", p.pairs);
    const net = p.up - p.down;
    if (p.fills || net) {
      this.onEvent({ t: now, win, oid: null, type: "info", side: null, price: null, size: null,
        note: `window closed · ${p.fills} fill(s) · holding ${posWords(p.up, p.down)}${net && p.mark != null ? `, marked ${cents(p.mark)}` : ""} · awaiting the label` });
    }
    this.save();
  }

  /** A label arrived (provisional Chainlink, or Gamma's final). Returns the window summary if anything changed. */
  settle(win: number, up: boolean, src: string): PaperSummary | null {
    const r = this.acct.settle(win, up, src);
    if (this.mode === "live" && r && !r.corrected) this.queueRedeem(win);
    if (!r) return null;
    const p = this.acct.wins.get(win)!;
    for (const f of this.logs.get(win)?.fills ?? []) f.settle = sideSign(f.side) * ((up ? 1 : 0) - f.price);
    const held = posWords(p.snap!.up, p.snap!.down);
    const pnl = this.acct.pnl(p);
    if (p.fills || r.payout) {
      this.onEvent({ t: Date.now(), win, oid: null, type: "settle", side: null, price: null, size: null,
        note: r.corrected
          ? `⚠ ${src} CORRECTED the label to ${up ? "UP" : "DOWN"}: ${held} now pays $${r.payout.toFixed(2)} · window PnL ${usd(pnl)}`
          : `settled ${up ? "UP" : "DOWN"} (${src}) · ${held} pays $${r.payout.toFixed(2)} · window PnL ${usd(pnl)}` });
      this.log(`[paper] ${win} ${r.corrected ? "re-settled" : "settled"} ${up ? "UP" : "DOWN"}: ${held} → $${r.payout.toFixed(2)}, PnL ${usd(pnl)}, cash $${this.acct.cash.toFixed(2)}`);
    }
    this.fillsVer++;
    this.eq.push([Date.now(), this.acct.equity()]);
    if (this.eq.length > EQ_CAP) this.eq = this.eq.filter((_, i) => i % 2 === 0 || i >= this.eq.length - 1000);
    this.eqVer++;
    this.save();
    return this.acct.summary(p);
  }

  /** live: redeem a window at its first label, if the wallet still holds its tokens (a net position, or pairs whose
   *  merge has not run: the redeem pays them too, so that merge is dropped). Which side won is the chain's business, not
   *  the label's, so a provisional label is enough; the job waits REDEEM_DELAY_MS and retries until the market has
   *  resolved on chain. */
  private queueRedeem(win: number): void {
    const p = this.acct.wins.get(win);
    if (!p?.cond || !p.fills || this.chain.some((j) => j.win === win && j.kind === "redeem")) return;
    const merging = this.chain.some((j) => j.win === win && j.kind === "merge");
    if (!merging && !(p.snap && (p.snap.up > 1e-9 || p.snap.down > 1e-9))) return;
    this.chain = this.chain.filter((j) => !(j.win === win && j.kind === "merge"));
    this.queueChain(win, p.cond, "redeem");
  }

  private queueChain(win: number, cond: string, kind: ChainJob["kind"], pairs?: number): void {
    if (!this.venue?.gasless || !CFG.liveChain) return;   // no Relayer API key, or LIVE_CHAIN off: Polymarket's own redeem does it
    this.chain.push({ win, cond, kind, tries: 0, next: Date.now() + (kind === "merge" ? 2000 : REDEEM_DELAY_MS), ...(pairs ? { pairs } : {}) });
    this.dirty = true;
  }

  /** One on-chain job at a time, oldest first. */
  private async runChain(): Promise<void> {
    if (this.chainBusy || !this.venue) return;
    const j = this.chain.find((x) => x.next <= Date.now());
    if (!j) return;
    this.chainBusy = true;
    try {
      const tx = j.kind === "merge" ? await this.venue.merge(j.cond, j.pairs ?? 0) : await this.venue.redeem(j.cond);
      this.chain = this.chain.filter((x) => x !== j);
      this.onEvent({ t: Date.now(), win: j.win, oid: null, type: "info", side: null, price: null, size: null,
        note: `${j.kind === "merge" ? "Up+Down pairs merged" : "redeemed"} on chain · tx ${tx ?? "?"}` });
    } catch (e) {
      j.tries++;
      const why = (e as Error).message?.slice(0, 200) ?? String(e);
      if (j.tries >= CHAIN_MAX_TRIES) {
        this.chain = this.chain.filter((x) => x !== j);
        this.log(`[live] ⚠ ${j.kind} of window ${j.win} failed ${j.tries} times (${why}): do it on polymarket.com`);
      } else {
        j.next = Date.now() + Math.min(600_000, 30_000 * j.tries);
        this.log(`[live] ${j.kind} of window ${j.win} failed (${why}), retry ${j.tries} in ${Math.round((j.next - Date.now()) / 1000)} s`);
      }
    } finally {
      this.chainBusy = false;
      this.save();
    }
  }

  /** Windows still holding inventory with no label, so the engine can label them after a restart. */
  unsettled(): number[] {
    return [...this.acct.wins.values()].filter((p) => p.state !== "settled").map((p) => p.win);
  }

  summary(win: number): PaperSummary | undefined {
    const p = this.acct.wins.get(win);
    return p && (p.fills || p.placed) ? this.acct.summary(p) : undefined;
  }

  /** The window's fills and order events, for the archive. */
  windowLog(win: number): { fills: Fill[]; events: (string | number | null)[][] } | undefined {
    const l = this.logs.get(win);
    if (!l) return undefined;
    return { fills: l.fills, events: l.events.map((e) => [e.t, e.type, e.oid, e.side, e.price, e.size, e.note, e.token ?? null, e.tokenPrice ?? null]) };
  }

  /** Restarted inside a window: carry its archived fills and events on. */
  resume(win: number, paper: { fills?: Fill[]; events?: any[][] } | undefined): void {
    if (!paper) return;
    const l = this.winLog(win);
    l.fills = paper.fills ?? [];
    l.events = (paper.events ?? []).map((a) => ({ seq: 0, t: a[0], type: a[1], oid: a[2], side: a[3], price: a[4], size: a[5], note: a[6], token: a[7] ?? null, tokenPrice: a[8] ?? null, win }));
    this.fillsVer++;
  }

  private winLog(win: number): WinLog {
    let l = this.logs.get(win);
    if (!l) {
      l = { events: [], fills: [] };
      this.logs.set(win, l);
      for (const k of this.logs.keys()) if (k < win - 3600) this.logs.delete(k);
    }
    return l;
  }

  private onEvent(e: Omit<OrderEvent, "seq">): void {
    const ev: OrderEvent = { seq: ++this.seq, ...e };
    this.ev.push(ev);
    if (this.ev.length > EV_RING) this.ev.splice(0, this.ev.length - EV_RING);
    const l = this.winLog(e.win);
    if (l.events.length < WIN_EV_CAP) l.events.push(ev);
    if (this.mode === "live" && (e.type === "live" || e.type === "cancelled")) this.dirty = true;   // the saved open-order ids
    if (this.mode === "live" && e.type === "place") {
      this.places.push(e.t);
      while (this.places.length && this.places[0] < e.t - 10_000) this.places.shift();
      if (this.places.length > CFG.liveMaxPlaces10s && e.t >= this.pauseUntil) {
        this.pauseUntil = e.t + 10_000;
        this.log(`[live] ⚠ ${this.places.length} orders in 10 s (LIVE_MAX_PLACES_10S ${CFG.liveMaxPlaces10s}): placing paused for 10 s`);
      }
    }
    const p = this.acct.wins.get(e.win);
    if (p) {
      if (e.type === "place") p.placed++;
      else if (e.type === "cancelled") p.cancelled++;
      else if (e.type === "reject") p.rejected++;
    }
  }

  // ---- persistence & aggregates ----------------------------------------------------------------
  save(): void {
    if (!this.trading) return;
    this.lastSave = Date.now(); this.dirty = false;
    this.acct.prune(Date.now() / 1000);
    const st = {
      v: 1, savedAt: Date.now(), since: this.since, ...(this.carry.length ? { carry: this.carry } : {}), start: this.acct.start, cash: this.acct.cash,
      nextOid: this.ex.nextId, nextFid: this.ex.nextFillId, wins: [...this.acct.wins.values()], eq: this.eq,
      // lastFillAt / busy: for a peer bot's wallet check (peers.ts)
      ...(this.mode === "live" ? { chain: this.chain, open: this.live!.openIds(), lastFillAt: this.lastFillAt, ...(this.chainBusy ? { busy: true } : {}) } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify(st));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch (e) { this.log(`[${this.mode}] save failed: ${(e as Error).message}`); }
  }

  /** Settled windows of this account from the index: today and all time. */
  recomputeAgg(): void {
    const date = utcDate(Date.now() / 1000);
    const today = emptyAgg(), all = emptyAgg(), ab: Record<string, PaperAgg> = {};
    for (const e of this.store.entries()) {
      const s = e.paper;
      if (!s || !s.settled || (e.startTs < this.since && !this.carry.includes(e.startTs))) continue;
      const live = this.acct.wins.get(e.startTs);
      if (live && live.state !== "settled") continue;
      addAgg(all, s);
      if (utcDate(e.startTs) === date) addAgg(today, s);
      const tag = e.name ?? e.tag ?? e.policy;       // the setup's short name (MM_TAG) when the window recorded one
      if (tag) addAgg((ab[tag] ??= emptyAgg()), s);
    }
    this.settledAgg = { date, today, all, ab };
    this.eqVer++;
  }

  private aggBlock() {
    const a = this.settledAgg!;
    const today = cloneAgg(a.today), all = cloneAgg(a.all);
    const ab: Record<string, PaperAgg> = Object.fromEntries(Object.entries(a.ab).map(([k, v]) => [k, cloneAgg(v)]));
    let open = 0;
    for (const p of this.acct.wins.values()) {
      if (p.state === "settled" && this.store.get(p.win)?.paper?.settled) continue;
      if (p.win < this.since && !this.carry.includes(p.win)) continue;   // settled before a PnL reset
      const s = this.acct.summary(p);
      open += s.pnl;
      addAgg(all, s);
      if (utcDate(p.win) === a.date) addAgg(today, s);
      // a window from before this run recorded no policy; one from this run is attributed the way it will be
      // (the window a restart resumed keeps the setup it opened with, which its cut index entry records)
      if (p.win >= this.bootWin) {
        const boot = p.win === this.bootWin ? this.store.get(p.win) : undefined;
        addAgg((ab[boot?.name ?? boot?.tag ?? windowName(p.win)] ??= emptyAgg()), s);
      }
    }
    return { date: a.date, today, all, ab, unsettledPnl: open };
  }

  // ---- dashboard -------------------------------------------------------------------------------
  frame(win: number, now: number, full: boolean) {
    const p = this.acct.wins.get(win);
    const out: any = { mode: this.mode };   // the quote itself rides on frame.quote
    if (!this.trading) return out;
    if (this.mode === "live") out.live = this.liveBlockInfo();
    const reserved = this.reserved(), equity = this.acct.equity();
    out.acct = { start: this.acct.start, cash: this.acct.cash, equity, pnl: equity - this.acct.start, reserved, free: this.acct.cash - reserved };
    out.pos = p ? this.posBlock(p) : null;
    out.settling = [...this.acct.wins.values()].filter((q) => q.win !== win && q.state === "settling")
      .map((q) => ({ win: q.win, up: q.up, down: q.down, mark: q.mark, pnl: this.acct.pnl(q), fills: q.fills }));
    out.orders = this.ex.visible(win).map((o) => ({
      id: o.id, side: o.side, price: o.price, size: o.size, filled: o.filled, status: o.status, live: o.liveAt != null,
      age: now - o.createdAt, rest: o.liveAt != null ? now - o.liveAt : null, queue: o.queue, queue0: o.queue0,
      level: o.lv.length ? o.lv[o.lv.length - 1][1] : null, reason: o.reason,
      token: o.token, tokenSide: o.tokenSide, tokenPrice: o.tokenPrice,
    }));
    out.actions = this.actions;
    out.ev = this.ev.filter((e) => e.seq > this.sentSeq);
    this.sentSeq = this.seq;
    if (this.fillsVer !== this.sentFillsVer) { out.fills = this.logs.get(win)?.fills ?? []; this.sentFillsVer = this.fillsVer; }
    if (this.eqVer !== this.sentEqVer) { out.eq = this.eq; this.sentEqVer = this.eqVer; }
    if (full) out.agg = this.aggBlock();
    return out;
  }

  hello(win: number | null) {
    return {
      mode: this.mode,
      cfg: {
        orderSize: CFG.orderSize, maxPosition: CFG.maxPosition, skewAtMax: CFG.skewAtMax, halfSpread: CFG.halfSpread,
        pairLockMin: CFG.pairLockMin, makerRebate: CFG.paperMakerRebate, raceLevel: CFG.raceLevel, raceShare: CFG.raceShare, raceOutbid: CFG.raceOutbid,
        reduceOnlyLeftSec: CFG.reduceOnlyLeftSec, requoteMinMs: CFG.requoteMinMs, latencyMs: CFG.paperLatencyMs, stepMs: CFG.paperStepMs, start: this.acct.start,
      },
      events: this.ev.slice(-EV_HELLO),
      fills: win != null ? this.logs.get(win)?.fills ?? [] : [],
      eq: this.eq,
      agg: this.trading ? this.aggBlock() : null,
    };
  }

  status() {
    return {
      mode: this.mode, cash: this.acct.cash, equity: this.acct.equity(), start: this.acct.start,
      working: this.ex.working().length, unsettled: this.unsettled(), agg: this.trading ? this.aggBlock() : null,
      ...(this.mode === "live" ? { live: this.liveBlockInfo() } : {}),
    };
  }

  private liveBlockInfo() {
    const lx = this.live!;
    return { wallet: this.venue!.wallet, balance: this.venueBal, link: this.venue!.connected(), halted: this.halted, maxLoss: CFG.liveMaxLoss,
      postMs: median(lx.lat.post), cancelMs: median(lx.lat.cancel), chain: this.chain.map((j) => ({ win: j.win, kind: j.kind, tries: j.tries })) };
  }

  private posBlock(p: WinPos) {
    const net = p.up - p.down;
    return {
      win: p.win, state: p.state, up: p.up, down: p.down, net,
      avgUp: p.up ? p.upCost / p.up : null, avgDown: p.down ? p.downCost / p.down : null,
      mark: p.mark, value: this.acct.value(p), pnl: this.acct.pnl(p), realized: p.realized,
      ifUp: p.cash + p.up, ifDown: p.cash + p.down,
      fills: p.fills, bought: p.bought, sold: p.sold, notional: p.notional, fillsCxl: p.fillsCxl ?? 0, fillsNoCxl: p.fillsNoCxl ?? 0, edge: p.edge, edgeN: p.edgeN,
      mk: p.mk, mkN: p.mkN, maxAbs: p.maxAbs, placed: p.placed, cancelled: p.cancelled, rejected: p.rejected,
      pairs: p.pairs, pairCost: p.pairCost, fees: p.fees ?? 0, rebate: p.rebate ?? 0,
    };
  }
}

function emptyAgg(): PaperAgg {
  return { windows: 0, traded: 0, won: 0, lost: 0, pnl: 0, fills: 0, bought: 0, sold: 0, notional: 0, fillsCxl: 0, fillsNoCxl: 0, edge: 0, edgeN: 0,
    mk: [0, 0, 0], mkN: [0, 0, 0], best: null, worst: null, placed: 0, cancelled: 0, rejected: 0, pairs: 0, pairCost: 0, fees: 0, rebate: 0 };
}

function cloneAgg(a: PaperAgg): PaperAgg {
  return { ...a, mk: [...a.mk] as PaperAgg["mk"], mkN: [...a.mkN] as PaperAgg["mkN"] };
}

function addAgg(a: PaperAgg, s: PaperSummary): void {
  a.windows++;
  if (s.fills) {
    a.traded++;
    if (s.pnl > 1e-9) a.won++; else if (s.pnl < -1e-9) a.lost++;
    a.best = a.best == null ? s.pnl : Math.max(a.best, s.pnl);
    a.worst = a.worst == null ? s.pnl : Math.min(a.worst, s.pnl);
  }
  a.pnl += s.pnl; a.fills += s.fills; a.bought += s.bought; a.sold += s.sold; a.notional += s.notional;
  a.fillsCxl += s.fillsCxl ?? 0; a.fillsNoCxl += s.fillsNoCxl ?? 0;
  a.edge += s.edge; a.edgeN += s.edgeN; a.placed += s.placed; a.cancelled += s.cancelled; a.rejected += s.rejected;
  a.pairs += s.pairs ?? 0; a.pairCost += s.pairCost ?? 0; a.fees += s.fees ?? 0; a.rebate += s.rebate ?? 0;
  for (let k = 0; k < 3; k++) { a.mk[k] += s.mk?.[k] ?? 0; a.mkN[k] += s.mkN?.[k] ?? 0; }
}

const usd = (x: number) => (x >= 0 ? "+$" : "−$") + Math.abs(x).toFixed(2);
function posWords(up: number, down: number): string {
  if (up > 1e-9) return `${+up.toFixed(2)} Up`;
  if (down > 1e-9) return `${+down.toFixed(2)} Down`;
  return "nothing";
}
