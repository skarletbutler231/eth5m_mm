// The frame clock. Every UI_PUSH_MS (100 ms) it prices the Up token, reads both books, scores the
// fair value against the market, steps the paper exchange (fills → inventory), quotes with that
// inventory, hands the quote to the order manager, records one row and pushes one frame to every
// dashboard. The nowcast blends Binance and Coinbase when both are fresh (fairValue.blendPath), and a
// Binance-only FV is priced alongside for the scorecard. Window lifecycle: market discovery (current + next), strikes, provisional label from
// Chainlink, final label from Gamma (each settles the paper inventory), archive.
import { anchoredFv, framePricers } from "./pricers.js";
import { Kick } from "./kick.js";
import { CFG } from "./config.js";
import { slugOf } from "./asset.js";
import type { BinanceFeed } from "./feeds/binance.js";
import type { CoinbaseFeed } from "./feeds/coinbase.js";
import type { RtdsFeed } from "./feeds/rtds.js";
import type { PmBookFeed, BookView } from "./feeds/pmBook.js";
import { fetchMarket, fetchOutcome, type Market, type Outcome, WIN } from "./feeds/gamma.js";
import { binanceStrike, venuePath, blendPath, type FvResult, type StampPath } from "./model/fairValue.js";
import { HfVol } from "./model/hfVol.js";
import { normCdf, normInv } from "./model/math.js";
import type { Calibrator } from "./model/calibration.js";
import { emptyScore, addLead, addSettle, mergeScore, summarize, type Score, type ScoreSummary } from "./model/scorecard.js";
import { applyTake, fastFor, flowFor, isV4, makeQuote, policyFor, POLICIES, quoteCfg, quoteTag, windowName, windowTag, type Policy } from "./quoter.js";
import type { FlowFv, FlowIn, FlowOut } from "./model/flowFv.js";
import { decideTake, takeCfg, type Take } from "./taker.js";
import { liveTick, makeQuoteCert, certCfg } from "./certainty.js";
import { applyGuard, Guard, guardCfg } from "./guard.js";
import { PairCost, pcCfg } from "./paircost.js";
import { Sweep, swCfg } from "./sweep.js";
import { Excess, xsCfg } from "./excess.js";
import { Lock, lockCfg, lockMinNet, lockTarget } from "./lock.js";
import { applyPending } from "./profile.js";
import { applyWindow, controlStatus, type WinSession, requestSize, setStopped, stopReason } from "./control.js";
import { FEEDS, MoveSignal, type Feed, type FillKind, type FillMsg, type MoveMsg, type SigSample } from "./signal.js";
import type { Fill } from "./trading/types.js";
import { PairTrader, type PairCtx } from "./pairTrader.js";
import { FollowTrader } from "./follow.js";
import type { Trader } from "./trading/trader.js";
import type { PaperSummary } from "./trading/account.js";
import { Store, utcDate, type IndexEntry } from "./store.js";
import { Regime, regimeCfg, winStats, type RegimeState } from "./regime.js";
import { hourRegimeFromCfg, type HourRegime, type HourRegimeState } from "./hourRegime.js";
import fs from "node:fs";

/** SIGNAL_TRACE=<file>: every sample the move signals see (each frame and 10 ms decide step) appended as
 *  [t, step (0 frame, 1 decide), target bid, target ask, book bid, book ask, pred ¢, centre (0 flow FV, 1 other), win],
 *  for replaying trigger rules against a book recording. Off unless set; meant for a shadow instance. */
const TRACE = process.env.SIGNAL_TRACE ? fs.createWriteStream(process.env.SIGNAL_TRACE, { flags: "a" }) : null;
import { monitorEventLoopDelay } from "node:perf_hooks";

// qb/qa = the quoter's target, wb/wa = paper orders actually on the book, inv = net Up shares held.
// cmid/bmid = raw Coinbase / Binance mids (asset.ts: ETH-USD / ETHUSDT), fvb = the FV on a Binance-only nowcast.
// gs = the slow part of FV − mid (its MM_EDGE_SLOW_SEC EMA), which the v2 quoter takes off the edge.
// ffv = the flow FV centre (mid + FLOW_FV_SCALE × fpred), fpred = its predicted mid move (¢), umid = the Binance perp mid;
// all three are recorded in every window, whichever centre the window quoted on (its tag says: "+ffv" = flow FV).
// Append only: settleFromRows reads archived rows by these indices (older rows simply end earlier).
export const COLS = ["el", "cl", "tw", "bin", "mid", "fv", "fva", "bb", "ba", "qb", "qa", "wb", "wa", "inv", "cmid", "bmid", "fvb", "gs", "ffv", "fpred", "umid"] as const;
/** Scorecard aggregates only windows priced by this model version. Bump on any pricing change. */
export const MODEL_VERSION = "fv3-cl-anchored-blend";
/** Versions whose archived rows and labels this one carries on (a restart inside a window, Gamma relabels). */
const CARRY_ON = new Set([MODEL_VERSION, "fv2-cl-anchored-ewma"]);

type NowcastSrc = "blend" | "binance" | "coinbase";

interface LeadPt { t: number; mid: number | null; fv: number | null; fva: number | null; fvb: number | null }
interface Label { up: boolean; src: "chainlink" | "gamma"; closeTwap?: number | null; priceToBeat?: number | null }

interface Win {
  startTs: number; endTs: number;
  market: Market | null; twapSec: 30 | 60;
  Kcl: number | null; KclSrc: "chainlink" | "basis" | null; KclSec: number | null;
  Kv: number | null; KvSrc: "binance" | "rest" | null; KvLag: number | null; kvBusy: boolean; kvNextTry: number;
  rows: (number | null)[][];
  nFrames: number;
  lead: LeadPt[]; lastLeadT: number;
  score: Score;
  ratios: number[];
  anchor: { z: number; m: number; sd: number; mid: number } | null;
  fvHist: { t: number; fv: number | null }[];
  /** Quoting policy of this window (A/B), and the EMA of FV − mid with its last update (ms). */
  policy: Policy;
  /** The quoting setup this window ran (policy + queue retention), recorded in the index. */
  tag: string;
  /** Its short name for the dashboard (MM_TAG, else the tag): the per-setup column it is counted in. */
  name: string;
  /** Quotes centre on the flow FV (tag "+ffv") instead of the anchored FV. */
  flow: boolean;
  /** Also decides between frames, every MM_DECIDE_STEP_MS (tag "+10ms"; engine.decide). */
  fast: boolean;
  gSlow: number | null; gSlowT: number;
  /** v4's tail guard (guard.ts): the mid's path and the rules' holds in this window; null with every rule off. */
  guard: Guard | null;
  /** v4's pair-cost rules (paircost.ts): the hold's state in this window; null with every rule off. */
  pc: PairCost | null;
  /** v4's excess takes (excess.ts): the cooldown in this window; null with every trigger off. */
  xs: Excess | null;
  /** v4's lock and stop (lock.ts, MM_LOCK_PCT): whether the window stopped market making; null when off. */
  lock: Lock | null;
  /** v4's sweep rules (sweep.ts): the mid's path, the fills seen and each side's hold in this window; null when they cannot act. */
  sw: Sweep | null;
  sigSum: number; sigN: number;
  label: Label | null;
  /** Move signals fired in this window (signal.ts), archived with it: /signal's, /signal-fast's and /signal-pair's. */
  signals: MoveMsg[];
  fastSignals: MoveMsg[];
  pairSignals: MoveMsg[];
  kappaMed: number | null;
  joinedLate: boolean;
  /** The market regime it opened on (regime.ts, MM_REGIME); null when off. */
  regime: RegimeState | null;
  /** The hour-of-day regime it opened in (hourRegime.ts, MM_HOUR_REGIME): applied, or shadow; null when off. */
  hourRegime: HourRegimeState | null;
  /** The session it opened in (control.ts, MM_SESSIONS), its size and cap, and whether it opened stopped; null when off. */
  session: WinSession | null;
  written: boolean; gammaDone: boolean; gammaBusy: boolean; gammaNext: number; gammaUntil: number;
}

/** The quoter config of each policy, v4's taker config and the certainty maker's config, built once (QCFG, LCFG and RACE
 *  again by rebuildKnobs when the live switch, profile.ts, changes the knobs they read). */
const buildQcfg = () => ({ v1: quoteCfg("v1"), v2: quoteCfg("v2"), v3: quoteCfg("v3"), v4: quoteCfg("v4"), v5: quoteCfg("v5") });
let QCFG = buildQcfg();
/** The tail guard (guard.ts) of v4 / v5 windows; null with every rule off. */
let GCFG = guardCfg();
/** The pair-cost rules (paircost.ts) of v4 / v5 windows; null with every rule off. */
const PCFG = pcCfg();
/** The excess takes (excess.ts) of v4 / v5 windows; null with every trigger off. */
const XCFG = xsCfg();
/** The lock and stop (lock.ts) of v4 / v5 windows; null when MM_LOCK_PCT and MM_LOCK_PX_F are off. */
let LCFG = lockCfg();
/** The sweep rules (sweep.ts) of v4 / v5 windows; null when they cannot act. */
const SWCFG = swCfg();
let TCFG = takeCfg();
const CERTCFG = certCfg();
const buildRace = () => CFG.raceLevel != null || CFG.raceShare != null || CFG.raceOutbid || CFG.joinMaxSh != null || CFG.joinRel != null
  ? { level: CFG.raceLevel, share: CFG.raceShare, holdMs: CFG.raceHoldMs, outbid: CFG.raceOutbid, inflight: CFG.raceInflight,
      joinMax: CFG.joinMaxSh, joinRel: CFG.joinRel, joinRefMs: CFG.joinRefMs } : null;
let RACE = buildRace();
/** After profile.ts changed SWITCH_KEYS in CFG, or the regime (regime.ts) the cap and size: what the engine built from them. */
function rebuildKnobs(): void { QCFG = buildQcfg(); GCFG = guardCfg(); TCFG = takeCfg(); LCFG = lockCfg(); RACE = buildRace(); }

/** The Up book's mid and spread, and whether it is good enough to mark and quote on: both sides, spread at most
 *  MAX_GOOD_SPREAD, fresher than MAX_BOOK_AGE_MS, inside 0.5–99.5¢. */
function bookState(up: BookView): { mid: number | null; spread: number | null; good: boolean } {
  const mid = up.ready && up.bestBid != null && up.bestAsk != null ? (up.bestBid + up.bestAsk) / 2 : null;
  const spread = up.bestBid != null && up.bestAsk != null ? up.bestAsk - up.bestBid : null;
  const good = mid != null && spread != null && spread <= CFG.maxGoodSpread + 1e-9 &&
    up.ageMs != null && up.ageMs <= CFG.maxBookAgeMs && mid > 0.005 && mid < 0.995;
  return { mid, spread, good };
}

/** The position pair mode quotes with: the target as a flat market maker would set it. */
const FLAT = { net: 0, up: 0, down: 0, avgUp: null, avgDown: null, pairs: 0, pairCost: 0 };

const r2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

function newWin(startTs: number, market: Market | null, joinedLate: boolean): Win {
  return {
    startTs, endTs: startTs + WIN, market, twapSec: market?.twapSec ?? 60,
    Kcl: null, KclSrc: null, KclSec: null, Kv: null, KvSrc: null, KvLag: null, kvBusy: false, kvNextTry: 0,
    rows: [], nFrames: 0, lead: [], lastLeadT: 0, score: emptyScore(), ratios: [],
    anchor: null, fvHist: [], policy: policyFor(startTs), tag: windowTag(startTs), name: windowName(startTs), flow: flowFor(startTs), fast: fastFor(startTs), gSlow: null, gSlowT: 0, guard: GCFG && isV4(policyFor(startTs)) ? new Guard(GCFG) : null, pc: PCFG && isV4(policyFor(startTs)) ? new PairCost(PCFG) : null, xs: XCFG && isV4(policyFor(startTs)) ? new Excess(XCFG) : null, lock: LCFG && isV4(policyFor(startTs)) ? new Lock(LCFG, lockTarget(), lockMinNet()) : null, sw: SWCFG && isV4(policyFor(startTs)) ? new Sweep(SWCFG) : null, sigSum: 0, sigN: 0, label: null, signals: [], fastSignals: [], pairSignals: [], kappaMed: null, joinedLate, regime: null, hourRegime: null, session: null,
    written: false, gammaDone: false, gammaBusy: false, gammaNext: 0, gammaUntil: 0,
  };
}

export class Engine {
  private cur: Win | null = null;
  private pending: Win[] = [];
  private markets = new Map<number, Market>();
  private marketBusy = new Set<number>();
  private marketNextTry = new Map<number, number>();
  private hf = new HfVol(CFG.volFastSec, CFG.volSlowSec, CFG.volFastWeight);
  private lastVolSec = -1;
  private subs: ((msg: unknown) => void)[] = [];
  private agg: { today: ScoreSummary; all: ScoreSummary; date: string } | null = null;
  private lastFrame: any = null;
  private orphans = new Map<number, { next: number; until: number; busy: boolean }>();
  private bootTs = Date.now();
  /** Market regime refit (regime.ts): null when MM_REGIME is off. */
  private regime: Regime | null = null;
  /** Hour-of-day regimes (hourRegime.ts): null when MM_HOUR_REGIME is off. */
  private hour: HourRegime | null = null;
  /** Event-loop delay: a stalled loop is what makes Polymarket drop the socket as a "slow consumer". */
  private loop = (() => { const h = monitorEventLoopDelay({ resolution: 10 }); h.enable(); return h; })();

  constructor(
    private readonly bin: BinanceFeed,
    private readonly cb: CoinbaseFeed | null,
    private readonly rtds: RtdsFeed,
    private readonly pm: PmBookFeed,
    private readonly calib: Calibrator,
    private readonly store: Store,
    private readonly trader: Trader,
    private readonly log: (m: string) => void,
    private readonly perp: BinanceFeed | null = null,
    private readonly ffv: FlowFv | null = null,
  ) {
    if (CFG.fillSignal.nocancel || CFG.fillSignal.race) this.trader.onFill = (f) => this.fillSignal(f);
    rebuildKnobs();   // a profile applied at boot (profile.ts bootProfile) changed the knobs after this module loaded
    this.hour = hourRegimeFromCfg(this.log);
    // MM_HOUR_REGIME=on replaces MM_REGIME (the user's call, 2026-11-17): the trailing-spread refit is not built then
    const rc = this.hour?.mode === "on" ? null : regimeCfg();
    if (rc) {
      this.regime = new Regime(rc, { cap: CFG.maxPosition, size: CFG.orderSize });
      // the windows archived before a restart, so the first window after it decides on the same 30 min as without one
      const st = Math.floor(Date.now() / 1000 / WIN) * WIN;
      for (let ts = st - rc.windows * WIN; ts < st; ts += WIN) {
        const f = this.store.readWindowSync(ts);
        if (Array.isArray(f?.rows) && Array.isArray(f?.cols)) this.regime.push(winStats(ts, f.rows, f.cols));
      }
    }
  }

  // ---- fill signal: WS /signal-fills (signal.ts "FILL SIGNAL") ----
  private fillSubs: ((m: FillMsg) => void)[] = [];
  private fillSeq = 0;
  private fillRecent: FillMsg[] = [];
  onFillSignal(cb: (m: FillMsg) => void): void { this.fillSubs.push(cb); }
  /** A maker fill of the current window, of a kind FILL_SIGNAL names, to the feed's subscribers. */
  private fillSignal(f: Fill): void {
    const w = this.cur;
    if (f.via === "take" || f.cxl == null || !w?.market || f.win !== w.startTs) return;
    const kind: FillKind | null = !f.cxl ? "nocancel" : f.cxlWhy === "race" ? "race" : null;
    if (!kind || !CFG.fillSignal[kind]) return;
    const now = Date.now(), up = this.pm.view(w.market.upToken, 1);
    const bid = up.ready ? up.bestBid : null, ask = up.ready ? up.bestAsk : null;
    // the token the bot ended up longer in: a buy of that token, or (never sent today) a sell of the other
    const tok = f.tokenSide === "BUY" ? f.token : f.token === "UP" ? "DOWN" : "UP";
    const r = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
    const m: FillMsg = {
      type: "fill", signal: "fills", seq: ++this.fillSeq, t: now, tFill: f.t, bot: CFG.mode, name: w.name, kind,
      win: w.startTs, slug: w.market.slug, up: w.market.upToken, down: w.market.downToken,
      dir: tok === "UP" ? "up" : "down", token: tok === "UP" ? w.market.upToken : w.market.downToken,
      price: r(tok === "UP" ? f.price : 1 - f.price)!, upPrice: r(f.price)!, size: f.size, oid: f.oid, restMs: Math.round(f.restMs), queue0: Math.round(f.queue0),
      book: { bid, ask, mid: bid != null && ask != null ? r((bid + ask) / 2) : null }, fv: r(f.fv),
      elapsed: r(now / 1000 - w.startTs)!, left: r(w.endTs - now / 1000)!,
    };
    this.fillRecent.push(m); if (this.fillRecent.length > 20) this.fillRecent.shift();
    for (const cb of this.fillSubs) { try { cb(m); } catch { /* */ } }
  }
  /** WS /signal-fills: on connect (with the last 20 fill signals of this window) and as the heartbeat. */
  fillHello() { return { ...this.fillBeat(), type: "hello", cfg: CFG.fillSignal, recent: this.fillRecent.filter((m) => m.win === this.cur?.startTs) }; }
  fillBeat() {
    return { type: "hb", signal: "fills", t: Date.now(), bot: CFG.mode, win: this.cur?.startTs ?? null, slug: this.cur?.market?.slug ?? null,
      armed: (CFG.fillSignal.nocancel || CFG.fillSignal.race) && this.trader.active };
  }

  /** Up tokens of the current and next window: the flow FV steps its order-flow imbalance on their book updates. */
  private ffvWatch = new Set<string>();
  /** What the last frame of a "+10ms" window hands decide(): its pricer inputs for the flow FV, the centre to fall back
   *  on when the book is not good, and the quote's other inputs. null = no decisions between frames. */
  private dctx: {
    win: number; ffvIn: Omit<FlowIn, "now" | "bids" | "asks" | "spot" | "perp">;
    fallback: number | null; fallbackSrc: string; fv: number | null; fva: number | null; move2s: number | null; minSize: number; tick: number;
    /** The frame's sigma, for MM_DECIDE_FV=fresh. */
    sigma: number | null;
  } | null = null;
  private lastDecide = 0;
  /** MM_DECIDE_EVENTS: the last decide step from either source, a pending event run, and the minute's tally for the log. */
  private readonly evKick = new Kick(CFG.decideEventMinMs, () => {
    try { this.decide("event"); } catch (e) { this.log(`[engine] event decide error: ${(e as Error).stack}`); }
  });
  private evStats = { n: 0, ms: [] as number[] };
  /** Big target-quote moves for other bots (signal.ts): WS /signal and WS /signal-fast, each its own detector. WS
   *  /signal-pair's is the pair trade's (pairDetector). */
  private sigs: Record<Exclude<Feed, "pair">, MoveSignal> = { signal: new MoveSignal(CFG.signal), fast: new MoveSignal(CFG.fastSignal, "fast") };
  /** PAPER_SWEEP_LAT=live (paper only): every target move of PAPER_SWEEP_LAT_MOVE within its lookback, nothing filtered,
   *  tells the paper venue it is busy (venueLatency.ts). Not a feed. */
  private latSig = CFG.mode === "paper" && CFG.paperFillModel === "sweep" && CFG.paperSweep.lat?.mode === "live"
    ? new MoveSignal({ ...CFG.signal, minMove: CFG.paperSweep.lat.move, lookbackMs: CFG.paperSweep.lat.lookbackMs, leadOnly: false,
        minPred: null, top: null, cooldownMs: 0 }, "lat")
    : null;
  private sigSubs: ((feed: Feed, m: MoveMsg) => void)[] = [];
  /** PAIR_TRADE=on: the windows trade the signal in pairs (pairTrader.ts) instead of making a market. */
  private pair: PairTrader | null = null;
  /** FOLLOW_TRADE=on: no market making; takes that follow another bot's maker fills (follow.ts). */
  private follow: FollowTrader | null = null;
  /** No market making in this app: the pair trade or the follow trade. */
  private get noMM(): boolean { return !!this.pair || !!this.follow; }

  onFrame(cb: (msg: unknown) => void): void { this.subs.push(cb); }
  private emit(msg: unknown): void { for (const cb of this.subs) { try { cb(msg); } catch { /* */ } } }
  onSignal(cb: (feed: Feed, m: MoveMsg) => void): void { this.sigSubs.push(cb); }

  /** One quote to the move detectors: the pair trade's leg 1 (on its own detector or, PAIR_SIGNAL=fast, on
   *  /signal-fast's) and the feeds go out at once, before the order manager runs. /signal-pair gets every signal the
   *  pair trade's detector fires, once leg 1 is with the trader (or a gate said no). */
  private signal(w: Win, up: BookView, x: Omit<SigSample, "win" | "slug" | "up" | "down">): void {
    if (!w.market) return;
    const s: SigSample = { ...x, win: w.startTs, slug: w.market.slug, up: w.market.upToken, down: w.market.downToken };
    if (TRACE) TRACE.write(JSON.stringify([x.now, x.step === "frame" ? 0 : 1, x.bid, x.ask, x.bb, x.ba, x.pred, x.centerSrc === "flow FV" ? 0 : 1, w.startTs]) + "\n");
    // first: an order sent on this very move (the pair's leg 1) already meets the busy venue
    if (this.latSig?.sample(s)) this.trader.noteMove(x.now);
    const c = this.pair && this.pairCtx(w, x.now, up)!;
    const own = c ? this.pair!.sample(s, c, x.now) : null;
    if (own) this.publish(w, "pair", own);
    for (const feed of ["fast", "signal"] as const) {
      const m = this.sigs[feed].sample(s);
      if (!m) continue;
      if (c && feed === "fast" && this.pair!.cfg.signal === "fast") { this.pair!.open(m, c, x.now); this.publish(w, "pair", m); }
      this.publish(w, feed, m);
    }
  }

  /** A signal to its feed's subscribers and the window's archive. */
  private publish(w: Win, feed: Feed, m: MoveMsg): void {
    w[FEEDS[feed].archive].push(m);
    for (const cb of this.sigSubs) { try { cb(feed, m); } catch { /* */ } }
  }

  /** The detector a feed's signals come from; /signal-pair's is the pair trade's (null: no pair trade in this app). */
  private detector(feed: Feed): MoveSignal | null {
    if (feed !== "pair") return this.sigs[feed];
    return !this.pair ? null : this.pair.cfg.signal === "fast" ? this.sigs.fast : this.pair.sig;
  }

  /** The pair trade's view of the window now (null = its market is not known yet). */
  private pairCtx(w: Win, now: number, up: BookView): PairCtx | null {
    if (!w.market) return null;
    return { win: w.startTs, endTs: w.endTs, elapsed: now / 1000 - w.startTs, left: w.endTs - now / 1000, minSize: w.market.minSize ?? 5,
      tick: w.market.tickSize ?? 0.01, book: up, rows: w.rows, cols: COLS, Kcl: w.Kcl };
  }

  /** Pair mode, in place of the order manager: the legs after this step's fills, and the dashboard's row. */
  private pairStep(w: Win, now: number, up: BookView): void {
    const c = this.pair && this.pairCtx(w, now, up);
    if (!c) return;
    this.pair!.step(c, now);
    this.trader.show(this.pair!.actions(c, now));
  }

  start(): void {
    if (CFG.pair.on && this.trader.trading) {
      const p = CFG.pair;
      this.pair = new PairTrader(this.trader, p, this.log);
      this.log(`[pair] PAIR_TRADE=on: no market making; pairs on ${this.pair.signalDesc()} · ` +
        (p.leg1 === "maker" ? `leg 1 a post-only bid of ${p.size} sh at the best bid for ${p.makerMs} ms${p.maxQueue != null ? ` (none with over ${p.maxQueue} sh ahead)` : ""}` : `leg 1 ${p.size} sh ≤ ask + ${(p.slip * 100).toFixed(1)}¢`) +
        `, leg 2 ${p.closeEdge != null ? `at a ${(p.closeEdge * 100).toFixed(1)}¢ edge or ` : ""}` +
        `${p.stopMove != null ? `on a ${(p.stopMove * 100).toFixed(1)}¢ Up mid move against leg 1 in ${p.stopMs} ms or ` : ""}` +
        `${p.holdMs} ms later ≤ ask + ${(p.closeSlip * 100).toFixed(1)}¢ · until ${p.untilSec} s, ≤ ${(p.maxPrice * 100).toFixed(0)}¢` +
        (this.pair.l2 ? ` · leg-2 model (${this.pair.l2.gbm.nTrees} trees): leg 2 at once at P(against) ≥ ${p.l2ModelP.toFixed(2)}` +
          (p.l2Model === "ab" ? ", even 5-minute slots only (odd = control)" : "") : "") +
        (CFG.mode === "live" ? ` · ⚠ LIVE: real orders (leg 1 ${p.leg1 === "maker" ? "post-only" : "fill-and-kill"}, leg 2 fill-and-kill)` : ""));
    } else if (CFG.pair.on) this.log("[pair] PAIR_TRADE=on in shadow mode: nothing is traded");
    if (CFG.follow.on && CFG.pair.on) throw new Error("FOLLOW_TRADE=on and PAIR_TRADE=on: one or the other");
    if (CFG.follow.on && this.trader.trading) {
      this.follow = new FollowTrader(this.trader, CFG.follow, () => {
        const w = this.cur, m = w?.market;
        if (!w || !m || Date.now() / 1000 >= w.endTs) return null;
        return { win: w.startTs, endTs: w.endTs, up: m.upToken, down: m.downToken, book: this.pm.view(m.upToken, 60), tick: m.tickSize ?? 0.01 };
      }, this.log);
      this.log(`[follow] FOLLOW_TRADE=on: no market making; ${this.follow.desc()}`);
      this.follow.connect();
    } else if (CFG.follow.on) this.log("[follow] FOLLOW_TRADE=on in shadow mode: nothing is traded");
    if (this.ffv) {
      const f = this.ffv;
      this.pm.onBookUpdate((a) => { if (this.ffvWatch.has(a)) f.onBook(a, this.pm.top(a)); });
      this.pm.onPrint((p) => f.onPrint(p.asset, p.price, p.size, p.side, p.rx));
    }
    if (CFG.raceOnBook && this.trader.trading && !this.noMM) {
      let lastErr = 0;
      this.pm.onBookUpdate((a) => {
        try { this.raceOnBook(a); } catch (e) { if (Date.now() - lastErr > 10_000) { lastErr = Date.now(); this.log(`[engine] race on book: ${(e as Error).stack}`); } }
      });
      this.log("[engine] MM_RACE_ON_BOOK=on: the queue race's exits also run on every update of the Up book (cancels only)");
    }
    this.recomputeAgg();
    const cutoff = Date.now() / 1000 - 6 * 3600;
    for (const e of this.store.entries()) {
      const curSt = Math.floor(Date.now() / 1000 / WIN) * WIN;   // the live path labels the window we resume into
      if (e.model != null && CARRY_ON.has(e.model) && e.src !== "gamma" && e.startTs > cutoff && e.startTs !== curSt) this.orphans.set(e.startTs, { next: 0, until: Date.now() + 30 * 60_000, busy: false });
    }
    // paper inventory still waiting for a label: settle from the index if it was labelled, else ask Gamma
    const curSt = Math.floor(Date.now() / 1000 / WIN) * WIN;
    for (const win of this.trader.unsettled()) {
      if (win >= curSt) continue;
      const e = this.store.get(win);
      if (e?.up != null) { this.settlePaper(win, e.up, e.src ?? "index"); if (e.src === "gamma") continue; }
      const o = this.orphans.get(win), until = Date.now() + 6 * 3600_000;
      if (o) o.until = Math.max(o.until, until); else this.orphans.set(win, { next: 0, until, busy: false });
    }
    if (this.orphans.size) this.log(`[settle] resuming Gamma labels for ${this.orphans.size} window(s) written before the restart`);
    const pts = this.bin.seed1s;
    const n = this.hf.seed(pts);
    if (pts.length) this.lastVolSec = Math.max(this.lastVolSec, pts[pts.length - 1].sec);
    this.log(n ? `[vol] seeded from ${n} Binance 1 s bars: sigma ${((this.hf.sigma() ?? 0) * 1e4).toFixed(3)} bps/sqrt s`
               : "[vol] no REST seed; warming from the live feed");
    setInterval(() => { try { this.tick(); } catch (e) { this.log(`[engine] tick error: ${(e as Error).stack}`); } }, CFG.uiPushMs);
    // live: wired whatever MM_DECIDE_EVENTS is now, since the dashboard's switch (profile.ts) may turn it on or off; each
    // kick reads the knob when it comes
    if ((CFG.decideEvents !== "off" || CFG.mode === "live") && CFG.decideStepMs > 0 && !this.noMM) {
      this.pm.onBookUpdate((a) => { const m = this.cur?.market; if (CFG.decideEvents !== "off" && m && a === m.upToken) this.evKick.kick(); });
      const onMid = () => { if (CFG.decideEvents === "all") this.evKick.kick(); };
      this.bin.onMid(onMid); this.perp?.onMid(onMid);
      this.log(`[engine] MM_DECIDE_EVENTS=${CFG.decideEvents}: decide steps also on ${CFG.decideEvents === "all" ? "Up book and Binance spot/perp mid" : CFG.decideEvents === "book" ? "Up book" : "no"} changes, at most every ${CFG.decideEventMinMs} ms`);
      setInterval(() => {
        const s = this.evStats, d = s.ms.sort((a, b) => a - b);
        if (s.n) this.log(`[engine] event decides ${s.n}/min (${this.evKick.deferred} waited for the ${CFG.decideEventMinMs} ms gap) · decide ${d[d.length >> 1].toFixed(2)} ms p50, ${d[Math.floor(d.length * 0.99)].toFixed(2)} p99`);
        this.evStats = { n: 0, ms: [] }; this.evKick.deferred = 0;
      }, 60_000).unref();
    }
    if (CFG.paperStepMs > 0 && CFG.paperStepMs < CFG.uiPushMs) {
      let lastErr = 0;
      setInterval(() => {
        try { this.stepFills(); this.decide(); } catch (e) { if (Date.now() - lastErr > 10_000) { lastErr = Date.now(); this.log(`[engine] paper step error: ${(e as Error).stack}`); } }
      }, CFG.paperStepMs);
    }
  }

  /** Between frames (PAPER_STEP_MS): the paper exchange matches the working orders against the live book and tape and the
   *  fills go into inventory, as a real venue would match them, without waiting for the next frame. Decisions (quote,
   *  takes, order manager) stay on the frame; the window roll stays there too. */
  private stepFills(): void {
    const w = this.cur, now = Date.now();
    if (!w?.market || now / 1000 >= w.endTs) return;
    const up = this.pm.view(w.market.upToken, 60);
    const { mid, good } = bookState(up);
    this.trader.pre({ now, win: w.startTs, endTs: w.endTs, up: w.market.upToken, down: w.market.downToken, cond: w.market.conditionId, book: up,
      fv: w.fvHist[w.fvHist.length - 1]?.fv ?? null, mid: good ? mid : null });
  }

  /** MM_RACE_ON_BOOK: an update of the live window's Up book runs the queue race's exits at once (trader.raceCheck →
   *  orderManager.raceOnly), instead of waiting up to 10 ms for decide() and its whole quote (flow FV, guard, takes).
   *  Cancels only; v4 / v5 windows. RACE is read at each call: the live switch (profile.ts) may rebuild it. */
  private raceOnBook(asset: string): void {
    const w = this.cur;
    if (!w?.market || asset !== w.market.upToken || !isV4(w.policy) || !RACE) return;
    const now = Date.now();
    if (now / 1000 >= w.endTs || !this.pm.connected || !this.trader.raceable(w.startTs)) return;
    this.trader.raceCheck(w.startTs, now, this.pm.view(w.market.upToken, 60), RACE);
  }

  /** Between frames (MM_DECIDE_STEP_MS; v4 windows tagged "+10ms"): the quote and the order manager again, right after
   *  stepFills' fills, on the latest Up book and with the flow FV re-scored now (FlowFv.peek: book, tape, Binance spot and
   *  perp); the frame's pricer inputs carry over. Takes stay on the frame. Why: Polymarket holds every taker order 150 ms
   *  but not our cancels, and the 100 ms frame spent most of that head start waiting (config decideStepMs). */
  /** src "timer": the MM_DECIDE_STEP_MS step (its own cadence, as before, and the only one that samples /signal);
   *  "event": an extra step on an input change (MM_DECIDE_EVENTS), at most every MM_DECIDE_EVENT_MIN_MS. */
  private decide(src: "timer" | "event" = "timer"): void {
    const c = this.dctx, w = this.cur, now = Date.now();
    if (!c || !w?.market || w.startTs !== c.win || now / 1000 >= w.endTs) return;
    if (src === "timer" ? now - this.lastDecide < CFG.decideStepMs : this.noMM) return;
    if (src === "event") {
      // a timer that woke a little early: go again at the gap's end rather than drop the change
      if (this.evKick.tooSoon(now)) { this.evKick.kick(); return; }
      // live: a fill or post answer heard but not yet booked (the account and the order's queue catch up in pre(), on the
      // 10 ms timer step): deciding now would see the order gone and the old position, so the timer step decides instead
      if (this.trader.unsynced()) return;
    }
    if (src === "timer") this.lastDecide = now;
    this.evKick.ran(now);
    const t0 = src === "event" ? performance.now() : 0;
    const up = this.pm.view(w.market.upToken, 60);
    const { mid, good } = bookState(up);
    // MM_DECIDE_FV=fresh: the model FV again now, on the latest Binance (and Coinbase / Chainlink) mids, with the frame's
    // sigma; the frame's anchor is read, not moved. frame (default): the frame's values, up to 100 ms old.
    let ffvIn = c.ffvIn, fv = c.fv, fva = c.fva, fallback = c.fallback, fallbackSrc = c.fallbackSrc;
    if (CFG.decideFv === "fresh") {
      const binFresh = this.bin.mids.last() != null && this.bin.connected && now - this.bin.lastRx < 5000;
      const cbFresh = !!this.cb && this.cb.fresh(now);
      const clT = this.rtds.spotLatest, clFresh = !!clT && now - clT.rx < 15_000;
      const { fvr, fvbr } = framePricers({ now, Kcl: w.Kcl, Kv: w.Kv, endMs: w.endTs * 1000, D: w.twapSec, sigma: c.sigma, eps2: this.calib.eps2,
        cl: this.rtds.spot, clFresh, bin: this.bin.mids, L: this.lag(), binFresh, nc: this.nowcastPath(binFresh, cbFresh) });
      ffvIn = { ...c.ffvIn, fv: fvbr?.fv ?? null, m: fvbr?.m ?? null, sd: fvbr?.sd ?? null, tau: fvbr?.tau ?? null, nowcast: fvbr?.nowcast ?? null,
        cl: this.rtds.spot.last(), clStamp: this.rtds.spot.lastTs() };
      fv = fvr?.fv ?? null;
      fva = anchoredFv(w.anchor, fvr, mid, good);
      fallback = fva ?? fv; fallbackSrc = fva != null ? "anchored FV" : "model FV";
    }
    let centre = fallback, centerSrc = fallbackSrc, pred: number | null = null;
    if (w.flow && this.ffv && good) {
      const binFresh = this.bin.connected && now - this.bin.lastRx < 5000;
      const perpFresh = !!this.perp && this.perp.connected && now - this.perp.lastRx < 5000;
      const o = this.ffv.peek({ ...ffvIn, now, bids: up.bids, asks: up.asks, spot: binFresh ? this.bin.mids : null, perp: perpFresh ? this.perp!.mids : null });
      if (o.centre != null) { centre = o.centre; centerSrc = "flow FV"; }
      pred = o.pred;
    }
    const pos = this.noMM ? FLAT : this.trader.position(w.startTs);
    let q = makeQuote({
      center: centre, centerSrc, move2s: c.move2s, elapsed: now / 1000 - w.startTs, left: w.endTs - now / 1000, tick: c.tick, minSize: c.minSize,
      bookReady: up.ready && this.pm.connected, bestBid: up.ready ? up.bestBid : null, bestAsk: up.ready ? up.bestAsk : null,
      net: pos.net, fv, mid, edgeSlow: w.gSlow, working: this.trader.workingSides(w.startTs),
      heldAvg: pos.net > 0 ? pos.avgUp : pos.net < 0 ? pos.avgDown : null,
      lead: good && fva != null ? fva - mid! : null, flowPred: centerSrc === "flow FV" ? pred : null,
    }, QCFG[w.policy === "v5" ? "v5" : "v4"]);
    const perpFresh = !!this.perp && this.perp.connected && now - this.perp.lastRx < 5000;
    let take: Take | null = null;
    if (!this.noMM) {
      const busy = this.trader.takeInFlight(w.startTs);
      const lk = this.lockStep(w, now, now / 1000 - w.startTs, w.endTs - now / 1000, good && this.pm.connected, up, busy != null);
      if (lk && (lk.stopped || lk.take)) take = lk.take;
      else if (w.xs && CFG.xs.fast && busy == null) {
        take = w.xs.decide({ now, elapsed: now / 1000 - w.startTs, left: w.endTs - now / 1000, good: good && this.pm.connected,
          bestBid: up.bestBid, bestAsk: up.bestAsk, bidSz: up.bids[0]?.[1] ?? null, askSz: up.asks[0]?.[1] ?? null, mid: good ? mid : null,
          centre, net: pos.net, heldAvg: pos.net > 0 ? pos.avgUp : pos.net < 0 ? pos.avgDown : null, perp: perpFresh ? this.perp!.mids : null,
          free: this.trader.free(), busy: false, minSize: c.minSize }).take;
      }
      q = applyTake(q, take?.token ?? busy, []);
    }
    if (w.guard && !this.noMM) {
      q = applyGuard(q, w.guard.observe({ now, mid: good ? mid : null, centre, left: w.endTs - now / 1000, net: pos.net,
        heldAvg: pos.net > 0 ? pos.avgUp : pos.net < 0 ? pos.avgDown : null, perp: perpFresh ? this.perp!.mids : null, tick: c.tick, minSize: c.minSize }), pos.net, c.minSize);
    }
    if (w.pc && !this.noMM) q = w.pc.apply(q, { centre, net: pos.net, heldAvg: pos.net > 0 ? pos.avgUp : pos.net < 0 ? pos.avgDown : null,
      pairs: pos.pairs, pairCost: pos.pairCost, tick: c.tick, minSize: c.minSize });
    if (w.sw && !this.noMM) q = w.sw.apply(q, { now, mid: good ? mid : null, alt: fva, perp: perpFresh ? this.perp!.mids : null,
      upBought: pos.up + pos.pairs, downBought: pos.down + pos.pairs, tick: c.tick, minSize: c.minSize });
    // event steps leave /signal alone: its detectors keep the timer's 10 ms samples (the hedge bot reads it)
    if (src === "timer") this.signal(w, up, { now, elapsed: now / 1000 - w.startTs, left: w.endTs - now / 1000, bid: q.bid, ask: q.ask, held: q.held,
      bb: up.ready ? up.bestBid : null, ba: up.ready ? up.bestAsk : null, centre, centerSrc, pred, step: "decide" });
    if (this.pair) this.pairStep(w, now, up);
    else if (this.follow) this.trader.show([]);
    else this.trader.post(w.startTs, q, now, c.minSize, { tick: c.tick, bestBid: up.ready ? up.bestBid : null, bestAsk: up.ready ? up.bestAsk : null, book: up, race: RACE }, take, true);
    if (src === "event") { this.evStats.n++; if (this.evStats.ms.length < 20_000) this.evStats.ms.push(performance.now() - t0); }
  }

  /** lock.ts (MM_LOCK_PCT / MM_LOCK_PX_F): the window's lock decision; a window that stops is stopped in the trader (makers off). null = off. */
  private lockStep(w: Win, now: number, elapsed: number, left: number, good: boolean, up: BookView, busy: boolean) {
    if (!w.lock || !w.market || this.noMM) return null;
    const b = this.trader.winBook(w.startTs);
    const r = w.lock.decide({ now, elapsed, left, good, bestBid: up.bestBid, bestAsk: up.bestAsk, up: b.up, down: b.down, cash: b.cash,
      upAvg: b.upAvg, downAvg: b.downAvg, fills: b.fills, free: this.trader.free(), busy });
    if (r.stop) this.trader.stopWindow(w.startTs, r.stop, now);
    return { take: r.take, steps: r.steps, stopped: r.stop != null };
  }

  private lag(): number { return Math.max(0, Math.min(3000, this.calib.lagMs)); }

  /** The nowcast's venue path: the Binance/Coinbase blend when both are fresh, else whichever one is. */
  private nowcastPath(binFresh: boolean, cbFresh: boolean): { path: StampPath; src: NowcastSrc } | null {
    const c = this.calib, lb = Math.max(0, Math.min(3000, c.blendLagB)), lc = Math.max(0, Math.min(3000, c.cbLagMs));
    if (binFresh && cbFresh && c.cbW > 0) return { path: blendPath(this.bin.mids, lb, this.cb!.mids, lc, c.cbW), src: c.cbW >= 1 ? "coinbase" : "blend" };
    if (binFresh) return { path: venuePath(this.bin.mids, this.lag()), src: "binance" };
    if (cbFresh) return { path: venuePath(this.cb!.mids, lc), src: "coinbase" };
    return null;
  }

  // ---- markets ---------------------------------------------------------------------------------
  private ensureMarket(startTs: number): void {
    if (this.markets.has(startTs) || this.marketBusy.has(startTs)) return;
    if (Date.now() < (this.marketNextTry.get(startTs) ?? 0)) return;
    this.marketBusy.add(startTs);
    fetchMarket(startTs)
      .then((m) => { if (m) { this.markets.set(startTs, m); this.log(`[gamma] ${m.slug} up …${m.upToken.slice(-6)} down …${m.downToken.slice(-6)} twap ${m.twapSec}s tick ${m.tickSize}`); } })
      .catch(() => { /* retry */ })
      .finally(() => { this.marketBusy.delete(startTs); this.marketNextTry.set(startTs, Date.now() + 2000); });
  }

  // ---- strikes ---------------------------------------------------------------------------------
  private strikes(w: Win, now: number): void {
    // PRICE TO BEAT = Chainlink's TWAP report stamped at the open (Gamma's eventMetadata.priceToBeat
    // equals it to the last digit, but Gamma only publishes it after the close). RTDS has no replay,
    // so a window the bot joined after its open gets an ESTIMATE: Binance's own strike times the live
    // Chainlink/Binance basis, whose residual sd is ~0.16 bps. ⛔ Not polymarket.com's crypto-price
    // `openPrice`: that is Chainlink SPOT at the boundary (checked 2026-10-07, window 1791395700:
    // openPrice 83105.84 = spot, priceToBeat 83114.05 = TWAP60).
    if (w.Kcl == null || w.KclSrc === "basis") {
      const rep = this.rtds.reportAt(w.startTs, w.twapSec);
      if (rep) {
        w.Kcl = rep.value; w.KclSrc = "chainlink"; w.KclSec = rep.sec;
        this.log(`[strike] ${w.startTs} price to beat $${rep.value.toFixed(2)} (TWAP${w.twapSec} report @+${rep.sec - w.startTs}s)`);
      } else if (w.Kcl == null && w.Kv != null && this.calib.basis != null &&
                 (w.joinedLate || this.rtds.missedAt(w.startTs, w.twapSec) || now / 1000 - w.startTs > 20)) {
        w.Kcl = w.Kv * Math.exp(this.calib.basis); w.KclSrc = "basis";
        this.log(`[strike] ${w.startTs} no Chainlink report seen at the open — price to beat ESTIMATED $${w.Kcl.toFixed(2)} (Binance strike × basis ${(this.calib.basis * 1e4).toFixed(2)} bps)`);
      }
    }
    if (w.Kv == null) {
      const L = this.lag();
      const kv = binanceStrike(this.bin.mids, w.startTs * 1000, w.twapSec, L);
      if (kv != null) { w.Kv = kv; w.KvSrc = "binance"; w.KvLag = L; return; }
      if (!w.kvBusy && now >= w.kvNextTry) {
        w.kvBusy = true;
        const b = w.startTs * 1000 - L, a = b - w.twapSec * 1000;
        this.bin.meanFromRest(a, b)
          .then((v) => { if (v != null && w.Kv == null) { w.Kv = v; w.KvSrc = "rest"; w.KvLag = L; this.log(`[strike] ${w.startTs} Binance strike from REST 1 s bars $${v.toFixed(2)} (joined after the open)`); } })
          .catch(() => { /* retry */ })
          .finally(() => { w.kvBusy = false; w.kvNextTry = Date.now() + 5000; });
      }
    }
  }

  // ---- the frame -------------------------------------------------------------------------------
  private tick(): void {
    const now = Date.now();
    const st = Math.floor(now / 1000 / WIN) * WIN;
    if (!this.cur || this.cur.startTs !== st) this.roll(st, now);
    const w = this.cur!;
    this.ensureMarket(st); this.ensureMarket(st + WIN);
    if (!w.market && this.markets.has(st)) { w.market = this.markets.get(st)!; w.twapSec = w.market.twapSec; }
    // The next window's books only join in the last 20 s: the CLOB socket drops "slow consumers" during
    // bursts (server-side queue, measured: our event loop stays < 2 ms), so carry half the traffic otherwise.
    const nx = now / 1000 >= w.endTs - 20 ? this.markets.get(st + WIN) : undefined;
    this.pm.setTokens([w.market?.upToken, w.market?.downToken, nx?.upToken, nx?.downToken].filter((x): x is string => !!x));
    this.strikes(w, now);
    this.processPending(now);

    const sec = Math.floor(now / 1000);
    if (sec > this.lastVolSec) {
      const px = this.bin.mids.at(sec * 1000);
      if (px != null) this.hf.update(sec, px);
      this.lastVolSec = sec;
    }
    const sigBase = this.hf.sigma();
    const sigma = sigBase != null ? Math.max(this.calib.kappa * sigBase, CFG.sigmaMinBps * 1e-4) : null;
    const L = this.lag();
    const S = this.bin.mids.last();
    const binFresh = S != null && this.bin.connected && now - this.bin.lastRx < 5000;
    const cbFresh = !!this.cb && this.cb.fresh(now);
    const clT = this.rtds.spotLatest;
    const clFresh = !!clT && now - clT.rx < 15_000;
    const nc = this.nowcastPath(binFresh, cbFresh);
    // the anchored FV on the nowcast (else the venue FV) and the same on Binance alone (pricers.ts; decide() reruns it)
    const { fvr, fvbr } = framePricers({ now, Kcl: w.Kcl, Kv: w.Kv, endMs: w.endTs * 1000, D: w.twapSec, sigma, eps2: this.calib.eps2,
      cl: this.rtds.spot, clFresh, bin: this.bin.mids, L, binFresh, nc });
    const fvb = fvbr?.fv ?? null;
    if (fvr && sigBase != null) { w.sigSum += sigBase; w.sigN++; }

    // ---- book (deep on Up: the paper exchange needs the size at its own price) ----
    const up = this.pm.view(w.market?.upToken, 60);
    const dn = this.pm.view(w.market?.downToken, 15);
    const { mid, spread, good } = bookState(up);

    // ---- market-anchored FV: last good mid carried forward by the Binance move since ----
    let fva: number | null = null;
    if (fvr) {
      if (good && (!w.anchor || w.anchor.mid !== mid)) w.anchor = { z: normInv(mid!), m: fvr.m, sd: fvr.sd, mid: mid! };
      if (w.anchor) fva = normCdf((w.anchor.z * w.anchor.sd + (fvr.m - w.anchor.m)) / fvr.sd);
    }
    const fv = fvr?.fv ?? null;

    // ---- flow FV: mid + scale × the predicted mid move, from order flow (model/flowFv.ts); every window records it ----
    let fo: FlowOut | null = null;
    const perpFresh = !!this.perp && this.perp.connected && now - this.perp.lastRx < 5000;
    if (this.ffv && w.market) {
      this.ffvWatch = new Set([w.market.upToken, this.markets.get(w.startTs + WIN)?.upToken].filter((x): x is string => !!x));
      fo = this.ffv.frame({ now, startTs: w.startTs, up: w.market.upToken, down: w.market.downToken, bids: up.bids, asks: up.asks,
        fv: fvbr?.fv ?? null, m: fvbr?.m ?? null, sd: fvbr?.sd ?? null, tau: fvbr?.tau ?? null, nowcast: fvbr?.nowcast ?? null,
        cl: this.rtds.spot.last(), clStamp: this.rtds.spot.lastTs(), sigBase, kappa: this.calib.kappa,
        spot: binFresh ? this.bin.mids : null, perp: perpFresh ? this.perp!.mids : null });
    }
    const flowCentre = w.flow && good && fo?.centre != null ? fo.centre : null;
    const centre = flowCentre ?? fva ?? fv;
    const centerSrc = flowCentre != null ? "flow FV" : fva != null ? "anchored FV" : "model FV";

    // ---- slow part of FV − mid: the persistent model bias the v2 edge leaves out ----
    if (fv != null && mid != null && CFG.edgeSlowSec != null) {
      const g = fv - mid;
      w.gSlow = w.gSlow == null ? g : w.gSlow + (1 - 2 ** (-(now - w.gSlowT) / (CFG.edgeSlowSec * 1000))) * (g - w.gSlow);
      w.gSlowT = now;
    }

    // ---- 2 s FV move for the pull rule ----
    w.fvHist.push({ t: now, fv });
    while (w.fvHist.length && w.fvHist[0].t < now - 2600) w.fvHist.shift();
    const ref = w.fvHist.find((x) => x.t >= now - 2000 - CFG.uiPushMs / 2);
    const move2s = fv != null && ref?.fv != null && ref.t <= now - 1500 ? fv - ref.fv : null;

    const el = now / 1000 - w.startTs, left = w.endTs - now / 1000;
    const tick = w.market?.tickSize ?? 0.01;

    // ---- paper exchange → inventory → quote → order manager ----
    this.trader.pre({ now, win: w.startTs, endTs: w.endTs, up: w.market?.upToken ?? null, down: w.market?.downToken ?? null, cond: w.market?.conditionId ?? null, book: up, fv, mid: good ? mid : null });
    const minSize = w.market?.minSize ?? 5;
    // pair mode quotes as a flat market maker would: the target is only the signal's input there
    const pos = this.noMM ? FLAT : this.trader.position(w.startTs);
    // cert prices on the tick in force (0.1¢ beyond 96¢ / 4¢); the other policies keep the market's listed tick
    const qTick = w.policy === "cert" ? liveTick(tick, up) : tick;
    let q = w.policy === "cert" ? makeQuoteCert({
      fv, fva, move2s, elapsed: el, left, tick: qTick, minSize, bookReady: up.ready && this.pm.connected,
      bestBid: up.ready ? up.bestBid : null, bestAsk: up.ready ? up.bestAsk : null, net: pos.net,
    }, CERTCFG) : makeQuote({
      center: centre, centerSrc, move2s, elapsed: el, left, tick, minSize,
      bookReady: up.ready && this.pm.connected, bestBid: up.ready ? up.bestBid : null, bestAsk: up.ready ? up.bestAsk : null,
      net: pos.net, fv, mid, edgeSlow: w.gSlow, working: this.trader.workingSides(w.startTs),
      heldAvg: pos.net > 0 ? pos.avgUp : pos.net < 0 ? pos.avgDown : null,
      lead: good && fva != null ? fva - mid! : null, flowPred: flowCentre != null ? fo?.pred ?? null : null,
    }, QCFG[w.policy]);
    // ---- v4 takes: rebalance / order flow; the bid a take would cross is pulled while it is out ----
    let take: Take | null = null;
    if (isV4(w.policy) && !this.noMM) {
      const busy = this.trader.takeInFlight(w.startTs);
      const d = decideTake({
        elapsed: el, left, minSize, good: good && this.pm.connected, bestBid: up.bestBid, bestAsk: up.bestAsk,
        bidSz: up.bids[0]?.[1] ?? null, askSz: up.asks[0]?.[1] ?? null, net: pos.net, center: centre,
        free: this.trader.free(), busy: busy != null, sinceFlowMs: this.trader.sinceFlowTake(w.startTs, now),
      }, TCFG);
      if (w.market) take = d.take;
      let tsteps = d.steps;
      const lk = this.lockStep(w, now, el, left, good && this.pm.connected, up, busy != null);
      if (lk && (lk.stopped || lk.take)) { take = lk.take; tsteps = lk.steps; }       // the lock's take only, no other
      else if (lk) tsteps = [...tsteps, ...lk.steps];
      if (w.xs && w.market && !take && busy == null && !lk?.stopped) {
        const x = w.xs.decide({ now, elapsed: el, left, good: good && this.pm.connected, bestBid: up.bestBid, bestAsk: up.bestAsk,
          bidSz: up.bids[0]?.[1] ?? null, askSz: up.asks[0]?.[1] ?? null, mid: good ? mid : null, centre, net: pos.net,
          heldAvg: pos.net > 0 ? pos.avgUp : pos.net < 0 ? pos.avgDown : null, perp: perpFresh ? this.perp!.mids : null,
          free: this.trader.free(), busy: false, minSize });
        take = x.take; tsteps = [...tsteps, ...x.steps];
      }
      q = applyTake(q, take?.token ?? busy, tsteps);
      if (w.guard) q = applyGuard(q, w.guard.observe({ now, mid: good ? mid : null, centre, left, net: pos.net,
        heldAvg: pos.net > 0 ? pos.avgUp : pos.net < 0 ? pos.avgDown : null, perp: perpFresh ? this.perp!.mids : null, tick, minSize }), pos.net, minSize);
      if (w.pc) q = w.pc.apply(q, { centre, net: pos.net, heldAvg: pos.net > 0 ? pos.avgUp : pos.net < 0 ? pos.avgDown : null,
        pairs: pos.pairs, pairCost: pos.pairCost, tick, minSize });
      if (w.sw) q = w.sw.apply(q, { now, mid: good ? mid : null, alt: fva, perp: perpFresh ? this.perp!.mids : null,
        upBought: pos.up + pos.pairs, downBought: pos.down + pos.pairs, tick, minSize });
    }
    this.signal(w, up, { now, elapsed: el, left, bid: q.bid, ask: q.ask, held: q.held, bb: up.ready ? up.bestBid : null, ba: up.ready ? up.bestAsk : null,
      centre, centerSrc, pred: fo?.pred ?? null, step: "frame" });
    // cert improves the best bid on purpose: the order manager's stay-at-the-touch rule (no book given) would hold it back
    const touch = w.policy === "cert" ? { bestBid: null, bestAsk: null } : { bestBid: up.ready ? up.bestBid : null, bestAsk: up.ready ? up.bestAsk : null };
    // v4's bids leave a level they are losing the race for (orderManager: queue race)
    const race = isV4(w.policy) ? RACE : null;
    if (this.pair) this.pairStep(w, now, up);
    else if (this.follow) this.trader.show([]);
    else if (w.market) this.trader.post(w.startTs, q, now, minSize, { tick: qTick, ...touch, book: up, race }, take);
    // ---- what decide() re-runs between frames ("+10ms" windows) ----
    this.dctx = w.fast && isV4(w.policy) && w.market ? {
      win: w.startTs,
      ffvIn: { startTs: w.startTs, up: w.market.upToken, down: w.market.downToken, fv: fvbr?.fv ?? null, m: fvbr?.m ?? null, sd: fvbr?.sd ?? null,
        tau: fvbr?.tau ?? null, nowcast: fvbr?.nowcast ?? null, cl: this.rtds.spot.last(), clStamp: this.rtds.spot.lastTs(), sigBase, kappa: this.calib.kappa },
      fallback: fva ?? fv, fallbackSrc: fva != null ? "anchored FV" : "model FV", fv, fva, move2s, minSize, tick, sigma,
    } : null;

    // ---- scoring ----
    if (now - w.lastLeadT >= 200) {
      w.lastLeadT = now;
      const pt: LeadPt = { t: now, mid: good ? mid : null, fv, fva, fvb };
      for (const [h, kf, ka, kb] of [[1000, "fv1", "fva1", "fvb1"], [5000, "fv5", "fva5", "fvb5"]] as const) {
        let j: LeadPt | null = null;
        for (let i = w.lead.length - 1; i >= 0; i--) { if (w.lead[i].t <= now - h + 60) { j = w.lead[i]; break; } }
        if (j && j.t >= now - h - 300 && j.mid != null && pt.mid != null) {
          const d = pt.mid - j.mid;
          if (j.fv != null) addLead(w.score.lead[kf], j.fv - j.mid, d);
          if (j.fva != null) addLead(w.score.lead[ka], j.fva - j.mid, d);
          if (j.fvb != null) addLead(w.score.lead[kb], j.fvb - j.mid, d);
        }
      }
      w.lead.push(pt);
      while (w.lead.length && w.lead[0].t < now - 6500) w.lead.shift();
      if (good && fv != null && fva != null) { w.score.mae.n++; w.score.mae.fv += Math.abs(fv - mid!); w.score.mae.fva += Math.abs(fva - mid!); }
      if (good && fv != null && fvb != null) { w.score.mae.nb++; w.score.mae.fvB += Math.abs(fv - mid!); w.score.mae.fvb += Math.abs(fvb - mid!); }
    }

    // ---- kappa: the market's implied vol over sigma_base, 90-290 s before the close ----
    if (w.nFrames % 5 === 0 && good && fvr && fvr.branch === "future" && left >= 90 && left <= 290 && fvr.tauEff > 0) {
      const zm = normInv(mid!);
      if (Math.abs(zm) >= 0.25 && fvr.m !== 0 && Math.sign(zm) === Math.sign(fvr.m)) {
        const s2 = ((fvr.m / zm) ** 2 - this.calib.eps2) / fvr.tauEff;
        if (s2 > 0 && sigBase != null && sigBase > 0) w.ratios.push(Math.sqrt(s2) / sigBase);
      }
    }

    // ---- row + frame ----
    const twT = this.rtds.twapLatest[w.twapSec];
    const cl = clT && now - clT.rx < 10_000 ? clT.v : null;
    const tw = twT && now - twT.rx < 10_000 ? twT.v : null;
    const Kdisp = w.Kcl ?? (w.Kv != null && this.calib.basis != null ? w.Kv * Math.exp(this.calib.basis) : null);
    // the model's own view of the Chainlink price right now (sub-second); venue fallback rebases Binance
    const binRe = fvr?.src === "anchored" ? fvr.nowcast : S != null && w.Kv != null && Kdisp != null ? (S * Kdisp) / w.Kv : null;
    const cbMid = cbFresh ? this.cb!.mids.last() : null;
    const row = [r2(el), r2(cl), r2(tw), r2(binRe), r4(mid), r4(fv), r4(fva), up.bestBid, up.bestAsk, q.bid, q.ask, ...this.trader.rowCols(w.startTs),
      r2(cbMid), r2(binFresh ? S : null), r4(fvb), r4(w.gSlow), r4(fo?.centre), r2(fo?.pred), r2(perpFresh ? this.perp!.mids.last() : null)];
    w.rows.push(row);
    w.nFrames++;

    const pmStats = this.pm.stats();
    const frame: any = {
      type: "frame", t: now, w: this.meta(w), row,
      live: {
        S, Kv: w.Kv, KvSrc: w.KvSrc, Kcl: w.Kcl, KclSrc: w.KclSrc, Kdisp,
        sigmaBase: sigBase, sigmaFast: this.hf.parts().fast, sigmaSlow: this.hf.parts().slow,
        kappa: this.calib.kappa, kappaN: this.calib.kappaHist.length, sigma,
        fvSrc: fvr?.src ?? null, nowcast: fvr?.nowcast ?? null, clAgeMs: fvr?.clAgeMs ?? null,
        epsBps: Math.sqrt(this.calib.eps2) * 1e4, epsSrc: this.calib.epsSrc, epsN: this.calib.epsN,
        lagMs: L, lagAuto: !this.calib.lagFixed, basisBps: this.calib.basis != null ? this.calib.basis * 1e4 : null,
        mBps: fvr ? fvr.m * 1e4 : null, sdBps: fvr ? fvr.sd * 1e4 : null, z: fvr?.z ?? null,
        tau: fvr?.tau ?? null, tauEff: fvr?.tauEff ?? null, branch: fvr?.branch ?? null, realized: fvr?.realized ?? null,
        fv, fva, move2s, mid, spread, good, ratiosN: w.ratios.length, joinedLate: w.joinedLate,
        cbMid, fvb, nc: this.ncBlock(nc?.src ?? null),
        ffv: this.ffv ? { on: w.flow, centre: fo?.centre ?? null, pred: fo?.pred ?? null, scale: CFG.flowFvScale, rise: CFG.flowFvScaleRise, fall: CFG.flowFvScaleFall, used: flowCentre != null, nNaN: fo?.nNaN ?? null } : null,
      },
      book: { up: compact(up), down: compact(dn), tick },
      quote: q,
      trade: this.trader.frame(w.startTs, now, w.nFrames % 5 === 1),
      feeds: {
        bin: { ok: binFresh, age: now - this.bin.lastRx, rate: this.bin.msgRate(), src: this.bin.src, lagP50: this.bin.lagP50() },
        cb: this.cb ? { ok: cbFresh, age: now - this.cb.lastRx, rate: this.cb.msgRate(), lagP50: this.cb.lagP50() } : null,
        rtds: { ok: this.rtds.connected && !!clT && now - clT.rx < 10_000, src: this.rtds.kind, spotAge: clT ? now - clT.rx : null, spotLag: clT ? clT.rx - clT.ts : null, twapAge: twT ? now - twT.rx : null },
        pm: { ok: this.pm.connected && up.ready, age: now - this.pm.lastRx, rate: pmStats.rate, lagP50: pmStats.lagP50 },
        perp: this.perp ? { ok: perpFresh, age: now - this.perp.lastRx, rate: this.perp.msgRate(), src: this.perp.src, lagP50: this.perp.lagP50() } : null,
        pushMs: CFG.uiPushMs,
      },
    };
    if (w.nFrames % 5 === 1) frame.score = this.scoreBlock(w);
    this.lastFrame = frame;
    this.emit(frame);
  }

  /** The nowcast mix for the dashboard: what priced this frame, and the calibrated blend. */
  private ncBlock(src: NowcastSrc | null) {
    const c = this.calib;
    return { src, on: !!this.cb, w: c.cbW, lagB: c.blendLagB, lagC: c.cbLagMs, wAuto: c.cbWFixed == null, lagAuto: c.cbLagFixed == null, fits: c.blendHist.length };
  }

  private scoreBlock(w: Win) {
    const live = mergeScore(emptyScore(), w.score);
    if (w.label) live.settle = settleFromRows(w.rows, w.label.up);
    return { live: summarize(live), today: this.agg?.today ?? null, all: this.agg?.all ?? null, date: this.agg?.date ?? null };
  }

  private meta(w: Win) {
    return {
      startTs: w.startTs, endTs: w.endTs, slug: w.market?.slug ?? slugOf(w.startTs), marketId: w.market?.marketId ?? null,
      twapSec: w.twapSec, Kcl: w.Kcl, KclSrc: w.KclSrc, Kv: w.Kv, KvSrc: w.KvSrc, tick: w.market?.tickSize ?? 0.01, policy: w.policy, tag: w.tag, name: w.name,
      ...(w.regime ? { regime: w.regime } : {}),
      ...(w.hourRegime ? { hourRegime: w.hourRegime } : {}),
      ...(w.session ? { session: w.session } : {}),
    };
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  private roll(st: number, now: number): void {
    const prev = this.cur;
    if (prev) {
      prev.kappaMed = this.calib.closeWindow(prev.startTs, prev.ratios);
      this.trader.closeWindow(prev.startTs, now);
      prev.gammaNext = now + 20_000; prev.gammaUntil = now + 30 * 60_000;
      this.pending.push(prev);
      this.log(`[window] ${prev.startTs} closed: ${prev.rows.length} frames, ${prev.ratios.length} kappa samples` +
        (prev.kappaMed != null ? ` (median ${prev.kappaMed.toFixed(3)} -> kappa ${this.calib.kappa.toFixed(3)})` : ""));
    }
    // the hour regime's knobs come off first, so the live switch and the next regime start from the base config
    let knobsChanged = this.hour?.restore() ?? false;
    // the live switch (profile.ts): a pending profile takes effect as this window opens, before its tag is set
    if (applyPending(st, this.log)) knobsChanged = true;
    // the session schedule and the panel's size switch (control.ts, MM_SESSIONS): this window's size and cap, the base the
    // market regime then works from, or a scheduled stop (its working orders, if any, cancelled now)
    const ctl = applyWindow(st, this.log);
    if (ctl.changed) { knobsChanged = true; this.regime?.setBase({ cap: CFG.maxPosition, size: CFG.orderSize }); }
    if (ctl.stop) this.trader.stopOrders(now, stopReason()!);
    // the market regime (regime.ts): the closed window joins the trailing state, which sets this window's cap and size
    let rg: RegimeState | null = null;
    if (this.regime) {
      if (prev && prev.rows.length) this.regime.push(winStats(prev.startTs, prev.rows, COLS));
      const was = this.regime.last?.name;
      rg = this.regime.decide(st);
      if (rg.cap !== CFG.maxPosition || rg.size !== CFG.orderSize) { CFG.maxPosition = rg.cap; CFG.orderSize = rg.size; rebuildKnobs(); }
      if (rg.name !== was) this.log(`[regime] window ${st} ${(was ?? "boot").toUpperCase()} → ${rg.name.toUpperCase()}: ` +
        `spread ${rg.spr != null ? (rg.spr * 100).toFixed(2) + "¢" : "n/a"}, vol ${rg.vol != null ? rg.vol.toFixed(2) + " bp" : "n/a"} over ${rg.n} windows → cap ${rg.cap}, size ${rg.size}`);
    }
    // the hour-of-day regime (hourRegime.ts): the window's opening UTC hour picks the regime; "on" sets its knobs
    let hr: HourRegimeState | null = null;
    if (this.hour) {
      const was = this.hour.last?.name;
      hr = this.hour.decide(st);
      if (hr.applied) knobsChanged = true;
      if (hr.name !== was) this.log(`[hour-regime] window ${st} (${String(hr.hour).padStart(2, "0")}:00 UTC) ${was ?? "boot"} → ${hr.name}` +
        ` ${hr.applied ? "APPLIED" : "shadow"}: ${Object.entries(hr.knobs).map(([k, v]) => `${k}=${v}`).join(" ") || "base config"}`);
    }
    if (knobsChanged) rebuildKnobs();
    this.cur = newWin(st, this.markets.get(st) ?? null, now / 1000 - st > 1.5);
    this.cur.regime = rg;
    this.cur.hourRegime = hr;
    const cs = controlStatus();
    this.cur.session = cs.session ? { label: cs.session.label, size: CFG.orderSize, cap: CFG.maxPosition, stopped: cs.stopped } : null;
    if (hr?.applied) this.cur.name += `-hr${hr.name}`;
    // Restarted inside a window that the shutdown flush archived: carry its rows and score sums on, so
    // the final record holds the whole window (with a gap) instead of only the part after the restart.
    const prior = this.store.get(st);
    if (prior?.cut && prior.model != null && CARRY_ON.has(prior.model)) {
      const f = this.store.readWindowSync(st);
      if (f?.rows?.length) {
        this.cur.rows = f.rows;
        this.cur.signals = Array.isArray(f.signals) ? f.signals : [];
        this.cur.fastSignals = Array.isArray(f.fastSignals) ? f.fastSignals : [];
        this.cur.pairSignals = Array.isArray(f.pairSignals) ? f.pairSignals : [];
        if (Array.isArray(f.pairs)) this.pair?.resume(st, f.pairs);
        this.cur.score = mergeScore(emptyScore(), prior.score);
        // RTDS has no replay: the strike seen at the open lives only in the index now
        if (prior.Kcl != null) { this.cur.Kcl = prior.Kcl; this.cur.KclSrc = (prior.KclSrc as Win["KclSrc"]) ?? null; }
        if (prior.Kv != null) { this.cur.Kv = prior.Kv; this.cur.KvSrc = (prior.KvSrc as Win["KvSrc"]) ?? null; }
        // a restart that changed MM_POLICY: the window finishes on the setup it opened with, so its tag stays true.
        // A restart that changed only the setup's settings (same policy, new tag) keeps the old tag too: nearly all
        // of the window ran on them, so it belongs in that setup's column.
        if (prior.policy && POLICIES.includes(prior.policy) && (prior.policy !== this.cur.policy || (prior.tag != null && prior.tag !== this.cur.tag))) {
          this.log(`[window] ${st} keeps the ${prior.tag ?? prior.policy} setup it opened with; ${this.cur.tag} starts with the next window`);
          this.cur.policy = prior.policy; this.cur.tag = prior.tag ?? quoteTag(prior.policy); this.cur.name = prior.name ?? this.cur.tag;
        }
        this.cur.flow = this.cur.tag.includes("+ffv");
        if (!this.cur.tag.includes("+guard")) this.cur.guard = null;
        if (!this.cur.tag.includes("+pc")) this.cur.pc = null;
        if (!this.cur.tag.includes("+swept")) this.cur.sw = null;
        this.trader.resume(st, f.paper);
        this.log(`[window] ${st} resumed after a restart: ${f.rows.length} frames from before it kept`);
      }
    }
    for (const k of this.markets.keys()) if (k < st - 3600) this.markets.delete(k);
  }

  private processOrphans(now: number): void {
    for (const [startTs, o] of this.orphans) {
      if (o.busy || now < o.next) continue;
      if (now > o.until) { this.orphans.delete(startTs); continue; }
      o.busy = true;
      fetchOutcome(startTs)
        .then(async (res) => {
          if (!res) return;
          this.orphans.delete(startTs);
          const e = this.store.get(startTs);
          const f = await this.store.readWindow(startTs);
          const score = mergeScore(emptyScore(), e?.score);
          if (f?.rows) score.settle = settleFromRows(f.rows, res.up);
          this.store.upsert({ startTs, up: res.up, src: "gamma", priceToBeat: res.priceToBeat, score });
          this.settlePaper(startTs, res.up, "gamma");
          this.recomputeAgg();
          this.log(`[settle] ${startTs} labelled after restart: ${res.up ? "UP" : "DOWN"} (Gamma)`);
        })
        .catch(() => { /* retry */ })
        .finally(() => { o.busy = false; o.next = Date.now() + 30_000; });
    }
  }

  /** Shutdown: archive the current (partial) window and every window still waiting for a label. */
  flush(): void {
    const all = [...this.pending, ...(this.cur ? [this.cur] : [])];
    for (const w of all) {
      if (w.written) continue;
      w.written = true;
      const e = { ...this.entry(w), cut: w === this.cur };
      this.store.upsert(e);
      try { this.store.writeWindowSync(w.startTs, { meta: { ...this.meta(w), up: e.up, src: e.src, closeTwap: e.closeTwap }, cols: COLS, rows: w.rows, paper: this.trader.windowLog(w.startTs), signals: w.signals, fastSignals: w.fastSignals, pairSignals: this.pair ? w.pairSignals : undefined, pairs: this.pair?.records(w.startTs), follows: this.follow?.records(w.startTs) }); }
      catch (err) { this.log(`[store] flush ${w.startTs} failed: ${(err as Error).message}`); }
    }
    this.trader.save();
    this.log(`[engine] flushed ${all.length} window(s) to the archive`);
  }

  private processPending(now: number): void {
    this.processOrphans(now);
    for (const w of [...this.pending]) {
      if (!w.label && w.Kcl != null && w.KclSrc === "chainlink") {
        const rep = this.rtds.reportAt(w.endTs, w.twapSec);
        if (rep) {
          w.label = { up: rep.value >= w.Kcl, src: "chainlink", closeTwap: rep.value };
          this.log(`[settle] ${w.startTs} provisional ${w.label.up ? "UP" : "DOWN"}: TWAP${w.twapSec} $${rep.value.toFixed(2)} vs $${w.Kcl.toFixed(2)} (margin $${(rep.value - w.Kcl).toFixed(2)})`);
          this.settlePaper(w.startTs, w.label.up, "chainlink", !w.written);
        }
      }
      if (!w.written && (w.label || now > w.endTs * 1000 + 90_000)) this.writeWindow(w);
      if (!w.gammaDone && !w.gammaBusy && now >= w.gammaNext) {
        if (now > w.gammaUntil) {
          w.gammaDone = true;
          this.log(`[settle] ${w.startTs} Gamma never finalised within 30 min — keeping the provisional label`);
          // paper inventory with no label at all keeps asking (a 0/1 payout always comes)
          if (!w.label && this.trader.unsettled().includes(w.startTs)) this.orphans.set(w.startTs, { next: now + 60_000, until: now + 6 * 3600_000, busy: false });
        } else {
          w.gammaBusy = true;
          fetchOutcome(w.startTs)
            .then((o) => { if (o) this.applyGamma(w, o); })
            .catch(() => { /* retry */ })
            .finally(() => { w.gammaBusy = false; w.gammaNext = Date.now() + 20_000; });
        }
      }
      if (w.written && w.gammaDone) this.pending.splice(this.pending.indexOf(w), 1);
    }
  }

  private finalScore(w: Win): Score {
    const s = mergeScore(emptyScore(), w.score);
    if (w.label) s.settle = settleFromRows(w.rows, w.label.up);
    return s;
  }

  private entry(w: Win): IndexEntry {
    return {
      startTs: w.startTs, endTs: w.endTs, slug: w.market?.slug ?? null, marketId: w.market?.marketId ?? null,
      twapSec: w.twapSec, Kcl: w.Kcl, KclSrc: w.KclSrc, Kv: w.Kv, KvSrc: w.KvSrc,
      up: w.label?.up ?? null, src: w.label?.src ?? null, closeTwap: w.label?.closeTwap ?? null, priceToBeat: w.label?.priceToBeat ?? undefined,
      kappa: this.calib.kappa, kappaMed: w.kappaMed, sigmaBase: w.sigN ? w.sigSum / w.sigN : null, model: MODEL_VERSION,
      epsBps: Math.sqrt(this.calib.eps2) * 1e4, lagMs: this.lag(), rows: w.rows.length, joinedLate: w.joinedLate,
      nc: this.cb ? { w: this.calib.cbW, lagB: this.calib.blendLagB, lagC: this.calib.cbLagMs } : null,
      score: this.finalScore(w), paper: this.trader.summary(w.startTs), policy: w.policy, tag: w.tag, name: w.name,
      ...(w.regime ? { regime: w.regime } : {}),
      ...(w.hourRegime ? { hourRegime: w.hourRegime } : {}),
      ...(w.session ? { session: w.session } : {}),
    };
  }

  private writeWindow(w: Win): void {
    w.written = true;
    const e = { ...this.entry(w), cut: false };
    this.store.upsert(e);
    this.store.writeWindow(w.startTs, { meta: { ...this.meta(w), up: e.up, src: e.src, closeTwap: e.closeTwap }, cols: COLS, rows: w.rows, paper: this.trader.windowLog(w.startTs), signals: w.signals, fastSignals: w.fastSignals, pairSignals: this.pair ? w.pairSignals : undefined, pairs: this.pair?.records(w.startTs), follows: this.follow?.records(w.startTs) })
      .catch((err) => this.log(`[store] write ${w.startTs} failed: ${(err as Error).message}`));
    this.recomputeAgg();
    this.trader.recomputeAgg();
  }

  private applyGamma(w: Win, o: Outcome): void {
    w.gammaDone = true;
    const prev = w.label;
    if (prev && prev.up !== o.up) this.log(`[settle] ⚠ ${w.startTs} provisional ${prev.up ? "UP" : "DOWN"} CORRECTED by Gamma to ${o.up ? "UP" : "DOWN"}`);
    w.label = { up: o.up, src: "gamma", closeTwap: prev?.closeTwap ?? null, priceToBeat: o.priceToBeat };
    this.settlePaper(w.startTs, o.up, "gamma", !w.written);
    if (o.priceToBeat != null && w.Kcl != null) {
      const errBps = Math.log(w.Kcl / o.priceToBeat) * 1e4;
      if (w.KclSrc === "basis") this.log(`[strike] ${w.startTs} estimated price to beat was off by ${errBps.toFixed(2)} bps ($${(w.Kcl - o.priceToBeat).toFixed(2)}) vs Gamma $${o.priceToBeat.toFixed(2)}`);
      else if (Math.abs(o.priceToBeat - w.Kcl) > 0.01) this.log(`[strike] ⚠ ${w.startTs} Chainlink report $${w.Kcl.toFixed(2)} vs Gamma price to beat $${o.priceToBeat.toFixed(2)}`);
    }
    if (w.written) {
      this.store.upsert({ startTs: w.startTs, up: o.up, src: "gamma", priceToBeat: o.priceToBeat, score: this.finalScore(w) });
      this.recomputeAgg();
    }
  }

  /** Pay out the window's paper inventory; an already-written index entry gets the settled summary. */
  private settlePaper(win: number, up: boolean, src: string, writeFollows = false): void {
    const s = this.trader.settle(win, up, src);
    if (!s) return;
    if (!writeFollows && this.store.get(win)) this.store.upsert({ startTs: win, paper: s });
    this.trader.recomputeAgg();
  }

  private recomputeAgg(): void {
    const date = utcDate(Date.now() / 1000);
    const all = emptyScore(), today = emptyScore();
    let nAll = 0, nToday = 0;
    for (const e of this.store.entries()) {
      if (!e.score || e.model !== MODEL_VERSION) continue;
      mergeScore(all, e.score); nAll++;
      if (utcDate(e.startTs) === date) { mergeScore(today, e.score); nToday++; }
    }
    this.agg = { today: summarize(today, nToday), all: summarize(all, nAll), date };
  }

  // ---- API -------------------------------------------------------------------------------------
  /** WS /signal and /signal-fast: on connect (with this window's signals so far) and as the heartbeat. */
  signalHello(feed: Feed) {
    const now = Date.now(), d = this.detector(feed);
    return { type: "hello", t: now, cfg: d?.cfg ?? null, ...this.feedState(feed, now), recent: this.cur?.[FEEDS[feed].archive].slice(-20) ?? [] };
  }
  signalBeat(feed: Feed) {
    const now = Date.now();
    return { type: "hb", t: now, ...this.feedState(feed, now) };
  }
  /** A feed's state for hello and hb; /signal-pair without a pair trade in this app is never armed. */
  private feedState(feed: Feed, now: number) {
    const d = this.detector(feed);
    return d ? { ...d.state(now), ...(feed === "pair" ? { signal: "pair" } : {}) }
      : { signal: feed, win: this.cur?.startTs ?? null, slug: this.cur?.market?.slug ?? null, armed: false, cut: null, off: "no pair trade in this app (PAIR_TRADE=off)" };
  }

  /** GET /api/hour-regime: the table, the mode, the current window's regime and the last 48 windows' (null when off). */
  hourRegimeStatus() { return this.hour?.status() ?? null; }

  hello() {
    const w = this.cur;
    return {
      type: "hello", cols: COLS, uiPushMs: CFG.uiPushMs, t: Date.now(),
      w: w ? this.meta(w) : null, rows: w ? w.rows : [], last: this.lastFrame,
      score: w ? this.scoreBlock(w) : null,
      trade: this.trader.hello(w ? w.startTs : null),
    };
  }

  windowList(date: string | null) {
    const dates = this.store.dates();
    const today = utcDate(Date.now() / 1000);
    if (!dates.includes(today)) dates.unshift(today);
    const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
    const list: any[] = this.store.byDate(d).map((e) => ({
      startTs: e.startTs, slug: e.slug, up: e.up, src: e.src, Kcl: e.Kcl, KclSrc: e.KclSrc, priceToBeat: e.priceToBeat,
      joinedLate: e.joinedLate, score: e.score ? summarize(e.score) : null,
      paper: paperBrief(this.trader.summary(e.startTs) ?? e.paper), policy: e.name ?? e.tag ?? e.policy ?? null, tag: e.tag ?? null,
    }));
    if (this.cur && utcDate(this.cur.startTs) === d) {
      const live = { startTs: this.cur.startTs, slug: this.cur.market?.slug ?? null, up: null, src: null, Kcl: this.cur.Kcl, KclSrc: this.cur.KclSrc, joinedLate: this.cur.joinedLate, live: true,
        paper: paperBrief(this.trader.summary(this.cur.startTs)), policy: this.cur.name, tag: this.cur.tag };
      const i = list.findIndex((x) => x.startTs === this.cur!.startTs);
      if (i >= 0) list[i] = live; else list.unshift(live);
    }
    for (const w of this.pending) {
      const x = list.find((y) => y.startTs === w.startTs);
      if (x && x.up == null && w.label) { x.up = w.label.up; x.src = w.label.src; }
    }
    return { date: d, dates, windows: list };
  }

  async windowSeries(startTs: number) {
    const mem = this.cur?.startTs === startTs ? this.cur : this.pending.find((w) => w.startTs === startTs);
    const e = this.store.get(startTs);
    const sum = e?.score ? summarize(e.score) : mem ? summarize(this.finalScore(mem)) : null;
    const paperSum = this.trader.summary(startTs) ?? e?.paper ?? null;
    if (mem) return { meta: { ...this.meta(mem), up: mem.label?.up ?? null, src: mem.label?.src ?? null }, cols: COLS, rows: mem.rows, live: mem === this.cur, score: sum,
      paper: this.trader.windowLog(startTs) ?? null, paperSum };
    const f = await this.store.readWindow(startTs);
    if (!f) return null;
    return { ...f, meta: { ...f.meta, up: e?.up ?? f.meta.up, src: e?.src ?? f.meta.src, priceToBeat: e?.priceToBeat ?? null }, score: sum,
      paper: f.paper ?? this.trader.windowLog(startTs) ?? null, paperSum };
  }

  status() {
    const now = Date.now();
    return {
      pairTrade: CFG.pair.on,
      ...(this.follow ? { follow: this.follow.status() } : {}),
      uptimeSec: Math.round((now - this.bootTs) / 1000),
      eventLoopMs: { p50: this.loop.percentile(50) / 1e6, p99: this.loop.percentile(99) / 1e6, max: this.loop.max / 1e6 },
      window: this.cur ? this.meta(this.cur) : null,
      pending: this.pending.map((w) => ({ startTs: w.startTs, label: w.label, written: w.written, gammaDone: w.gammaDone })),
      calib: {
        kappa: this.calib.kappa, kappaWindows: this.calib.kappaHist.length, kappaLast: this.calib.kappaHist.slice(-5),
        epsBps: Math.sqrt(this.calib.eps2) * 1e4, epsSrc: this.calib.epsSrc, epsN: this.calib.epsN,
        lagMs: this.calib.lagMs, lagAuto: !this.calib.lagFixed, lagHist: this.calib.lagHist.slice(-10),
        basisBps: this.calib.basis != null ? this.calib.basis * 1e4 : null, sigmaBase: this.hf.sigma(), model: MODEL_VERSION,
        blend: { ...this.ncBlock(this.lastFrame?.live?.nc?.src ?? null), last: this.calib.blendHist.slice(-5) },
      },
      feeds: this.lastFrame?.feeds ?? null,
      binance: { connected: this.bin.connected, src: this.bin.src, msgs: this.bin.msgs, reconnects: this.bin.reconnects, lastError: this.bin.lastError, bufferFrom: this.bin.mids.firstTs() },
      perp: this.perp ? { connected: this.perp.connected, src: this.perp.src, msgs: this.perp.msgs, reconnects: this.perp.reconnects, lastError: this.perp.lastError, lagP50: this.perp.lagP50() } : null,
      coinbase: this.cb ? { connected: this.cb.connected, msgs: this.cb.msgs, reconnects: this.cb.reconnects, lastError: this.cb.lastError, bufferFrom: this.cb.mids.firstTs() } : null,
      rtds: { connected: this.rtds.connected, src: this.rtds.kind, reconnects: this.rtds.reconnects, lastError: this.rtds.lastError },
      pm: { connected: this.pm.connected, msgs: this.pm.msgs, reconnects: this.pm.reconnects, lastError: this.pm.lastError, ...this.pm.stats() },
      score: this.agg,
      paper: this.trader.status(),
    };
  }

  /** Dashboard: start a fresh paper account with `start` USDC (null: not a paper account). */
  paperReset(start: number) {
    const now = Date.now();
    return this.trader.reset(start, this.cur?.startTs ?? Math.floor(now / 1000 / WIN) * WIN, now) ? this.trader.status() : null;
  }

  /** Dashboard: PnL restarts at zero, paper or live; cash, inventory and orders stay (null: shadow, nothing traded). */
  pnlReset() {
    const now = Date.now();
    return this.trader.resetPnl(this.cur?.startTs ?? Math.floor(now / 1000 / WIN) * WIN, now) ? this.trader.status() : null;
  }

  /** Dashboard: the size switch and the stop (control.ts). */
  control() { return { ...controlStatus(), halted: this.trader.status().live?.halted ?? null }; }

  /** Dashboard: {size} from the next window, {stopped} at once (stop cancels every working order now). */
  setControl(b: { size?: unknown; stopped?: unknown }): { ok: true } | { ok: false; error: string } {
    if (CFG.mode === "shadow") return { ok: false, error: "MM_MODE=shadow: nothing is traded" };
    if (b.size !== undefined) { const r = requestSize(b.size, this.log); if (!r.ok) return r; }
    if (typeof b.stopped === "boolean") {
      setStopped(b.stopped, this.log);
      if (b.stopped) this.trader.stopOrders(Date.now(), stopReason()!);
    }
    return { ok: true };
  }

  /** Dashboard, live: what a sync to the wallet would book (null: not live). */
  walletGap() { return this.trader.walletGap(); }

  /** Dashboard, live: book the wallet's collateral − the booked cash as a deposit; PnL unchanged. */
  async walletSync() {
    const r = await this.trader.syncWallet();
    return r.ok ? { ...r, status: this.trader.status() } : r;
  }

  /** Background calibrators, once a minute. */
  calibrate(): void {
    const p99 = this.loop.percentile(99) / 1e6, mx = this.loop.max / 1e6;
    if (mx > 250) this.log(`[loop] event-loop delay p99 ${p99.toFixed(0)} ms, max ${mx.toFixed(0)} ms over the last minute`);
    this.loop.reset();
    // the market feed's own delay, minute by minute: the live bot's book ran ~50 ms behind the paper bot's on 10-23 with
    // nothing logged to say why (README "Paper vs live, 5 windows"); PM_SOCKETS > 1 adds each socket's share of first copies
    this.log(`[pm-book] ${this.pm.minute()}`);
    this.calib.updateEps(this.cur?.twapSec ?? 60);
    this.calib.updateLag(this.rtds.spot, this.bin.mids);
    if (this.cb) this.calib.updateBlend(this.rtds.spot, this.bin.mids, this.cb.mids);
  }
}

/** Settlement score from archived rows: one sample per second on good-book seconds, >= 1 s before the close. */
export function settleFromRows(rows: (number | null)[][], up: boolean) {
  const I = Object.fromEntries(COLS.map((k, i) => [k, i])) as Record<(typeof COLS)[number], number>;
  const acc = emptyScore().settle;
  let lastSec = -1;
  for (const r of rows) {
    const el = r[I.el], mid = r[I.mid], fv = r[I.fv], fva = r[I.fva], bb = r[I.bb], ba = r[I.ba];
    if (el == null || el > 299) continue;
    const sec = Math.floor(el);
    if (sec === lastSec) continue;
    if (mid == null || fv == null || fva == null || bb == null || ba == null || ba - bb > CFG.maxGoodSpread + 1e-9 || mid <= 0.005 || mid >= 0.995) continue;
    lastSec = sec;
    addSettle(acc, fv, fva, mid, up, r[I.fvb] ?? null);
  }
  return acc;
}

function paperBrief(s: PaperSummary | undefined | null) {
  return s ? { pnl: s.pnl, settled: s.settled, fills: s.fills, maxAbs: s.maxAbs } : null;
}

function compact(v: BookView) {
  return {
    r: v.ready, b: v.bids.slice(0, 15), a: v.asks.slice(0, 15), age: v.ageMs,
    last: v.last ? { p: v.last.price, s: v.last.size, side: v.last.side, ts: v.last.ts } : null,
  };
}
