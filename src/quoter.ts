// QUOTER — the Up bid/ask the bot wants working right now, and every step of how it got there (the
// dashboard prints the steps). In paper mode the order manager turns this target into simulated orders;
// in shadow mode it is only drawn.
//
//   centre       the market-anchored fair value (last good mid carried forward by the Binance move
//                since), falling back to the model FV.
//   skew         reservation = centre − skewAtMax · (net / maxPosition) · p(1−p)/¼. Long Up shifts both
//                quotes down (buy less, sell more); p(1−p) is the variance of the 0/1 payoff, so the same
//                position is skewed hardest at 50¢ and barely at 5¢.
//   spread       ± MM_HALF_SPREAD around the reservation, floored/ceiled to the tick.
//   post-only    a bid is never placed at or above the best ask, an ask never at or below the best bid.
//   gates        no quotes in the first 15 s or the last 10 s (2026-10-07 markout study, pmqb memory
//                maker-markout-study-1007), none without a live book; pull the side a fresh Binance move is
//                running into (FV moved >= MM_PULL_MOVE over 2 s).
//   motion       no quotes at all while |FV move over 2 s| > MM_MAX_MOVE_2S.
//   edge (v1)    bid only when the model FV is at least MM_MIN_EDGE above the mid, ask only when it is that
//                far below. The two filters come from the 2026-10-08 loss study: 9 h of paper trading lost
//                1.96¢ a share, all of it within 30 s of the fills (a fill at the back of a 1k-share queue
//                mostly means the price ran through us). Replayed on 158 windows they took the cross-fill
//                PnL from −$3,823 to about breakeven; neither alone was enough.
//   edge (v2)    the edge is FV − mid less its slow part (MM_EDGE_SLOW_SEC EMA). A side that ADDS to |net|
//                needs MM_MIN_EDGE + MM_ENTRY_LAM · |net|/cap · p(1−p)/¼; a side that REDUCES |net| is quoted
//                unless the edge is MM_EXIT_BLOCK or more against it, and in reduce-only needs no edge. Why
//                (2026-10-09 study, 90 windows): pairs locked +$200 while the inventory v1 held to the close lost
//                $371. The slow part of FV − mid predicted nothing (beta 0.00 at 5-30 s, against +0.30 for the
//                rest), yet on its own it often cleared the v1 filter, kept buying one side and left the
//                reducing side quotable in only 18% of the time inventory was held.
//                Dead band: a side that already has a working order stays on down to MM_MIN_EDGE_KEEP (0.5¢)
//                instead of MM_MIN_EDGE, so edge noise around 1¢ does not cancel it and cost its queue spot.
//   pair (v2)    while holding, the other token's bid is priced to lock at least MM_PAIR_LOCK_MIN (5¢) a pair
//                against the held side's average cost: 25 Up @ 56¢ → a Down bid at ≤ 39¢. At the best price when
//                that already locks it (Up at 75¢: the Down bid at 25¢ locks 19¢), else resting at the lock price,
//                where it waits with queue priority. Sized to the whole position; no edge test, no pull rule.
//                Why (2026-10-10, 57 v2 windows): locking at the first 5¢ made +6.4¢/sh (sd 5.8); holding to
//                settlement −4.6¢ (sd 36); waiting for a first 15¢ +1.0¢ (sd 28), as most windows never get there.
//                Before it, the reducing side was blocked (exit held, pull) in ~2/3 of the frames a 10¢+ lock sat
//                at the best price. In the last MM_V2_REDUCE_ONLY_LEFT_SEC the reducing side flattens at any price.
//   size         MM_ORDER_SIZE, cut so a full fill cannot take |net| past MM_MAX_POSITION; a v2 side quoted
//                only as an exit is cut to |net| (it flattens, never flips); in the last MM_REDUCE_ONLY_LEFT_SEC
//                (v2: MM_V2_REDUCE_ONLY_LEFT_SEC) before the close only the side that reduces |net| is quoted,
//                sized to flatten.
//   edge (v3)    follow the market; add only when the model moved first. The signal is the anchored lead =
//                FV anchored − mid on a good book: the model's move since the market last moved. It is the v2
//                rule set with this signal instead of the de-biased edge, plus a lead pull: the side a lead of
//                MM_LEAD_PULL (0.5¢) or more is running into is pulled (the pair-lock is exempt). Why (2026-10-10,
//                230 windows): after |x| ≥ 1¢ the mid followed the lead +0.63¢ in 5 s and +0.85¢ in 15 s; it
//                followed the de-biased edge +0.22 / −0.01¢ and the raw FV − mid +0.19 / −0.05¢. The lead reads
//                ≥ 1¢ 21% of the time, the de-biased edge 77%.
//   v4           norm1e69's book (2026-10-10 study of its 34,586 BTC-5m fills): both tokens bid at the touch around
//                the anchored FV all window, the inventory skew stepping the long side back. No edge filter, motion
//                gate, pull or reduce-only. Quotes from MM_V4_FROM_SEC (5 s) to MM_V4_QUOTE_UNTIL_LEFT_SEC (30 s)
//                before the close. Its takes (taker.ts) run beside the quote; applyTake pulls the bid a take would cross.
//   v5           v4 + the tail guard (guard.ts) with the rules the tailguard agent found (2026-10-22): the vol cap
//                (MM_CAP_VOL_TV 0.3) and the gamma pull on the adding side (MM_GAMMA_PULL 0.6). Those are v5's defaults;
//                under v4 every guard rule is off unless set.
//   cert         the certainty maker (certainty.ts; "v5" until 2026-10-22): late in the window, only the near-certain
//                token, at its Glosten–Milgrom price. It does not go through makeQuote.
//   policy       MM_POLICY=v5 (default) · v4 · cert · v3 · v2 · v1 (legacy) · ab = v2 in even 5-minute slots, v1 in odd ones; the
//                index records each window's setup (quoteTag: the policy, "+queue" with the order manager's queue
//                retention, "+pair" with the v2/v3 pair-lock, "+take" with both of v4's takes ("+flow" / "+rebal" with one),
//                "+race" with v4's queue-race cancels ("+race+rif" when they also run in flight, MM_RACE_INFLIGHT), "+outbid" with its outbid cancels).
//   pairing      the bid and ask are Up-book prices; the order manager sends the ask as a Down bid at
//                1 − ask (the mirrored book), so both sides are BUYS and Up + Down fills merge for $1.
//                User-facing text says "Up bid" / "Down bid".
import { CFG } from "./config.js";
import type { Token } from "./trading/types.js";

export type StepState = "info" | "ok" | "warn" | "off";
export interface Step { k: string; v: string; s: StepState }

export interface QuoteIn {
  center: number | null;
  centerSrc: string;
  move2s: number | null;
  elapsed: number;
  left: number;
  tick: number;
  minSize: number;
  bookReady: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  /** Net Up shares held in this window: Up − Down. */
  net: number;
  /** Model FV and book mid, for the edge filter. */
  fv: number | null;
  mid: number | null;
  /** v2: the slow part of FV − mid (its EMA), subtracted from the edge. */
  edgeSlow?: number | null;
  /** v3: the anchored lead, FV anchored − mid on a good book (null otherwise): the model's move since the market last moved. */
  lead?: number | null;
  /** v2 dead band: which sides already have a working order. */
  working?: { bid: boolean; ask: boolean };
  /** v2 pair-lock: average cost per share of the held token (Up when net > 0, Down when net < 0). */
  heldAvg?: number | null;
  /** The flow FV's predicted mid move (¢) when `center` is the flow FV (mid + FLOW_FV_SCALE × it), else null: the
   *  per-side scales (FLOW_FV_SCALE_RISE / _FALL) move each bid's centre by it. */
  flowPred?: number | null;
}

/** cert quotes with certainty.ts (makeQuoteCert), not makeQuote. */
export type Policy = "v1" | "v2" | "v3" | "v4" | "v5" | "cert";
export const POLICIES: readonly Policy[] = ["v1", "v2", "v3", "v4", "v5", "cert"];
/** v4's quote, takes, queue race, flow FV and 10 ms decisions: v4 and v5 (= v4 + the tail guard's defaults). */
export const isV4 = (p: Policy | null | undefined): boolean => p === "v4" || p === "v5";

export interface Quote {
  policy: Policy | null;
  bid: number | null; ask: number | null;
  bidSize: number; askSize: number;
  center: number | null; skew: number; reservation: number | null;
  /** One line: the notable reasons, for logs and the order book footer. */
  why: string;
  /** Why a side has no target (null = it has one). */
  off: { bid: string | null; ask: string | null };
  /** A side the post-only rule held a tick off the other side of the book (its price says where the book is, not the
   *  centre): the pair detector's PAIR_MOVE=free leaves it out of the move. Missing = neither. */
  held?: { bid: boolean; ask: boolean };
  /** The cap the tail guard shrank this quote to (guard.ts vol cap), for the order manager's pending count; missing = the
   *  configured MM_MAX_POSITION. */
  cap?: number;
  /** The pair-cost cap (paircost.ts MM_PC_TARGET): the most aggressive Up-terms price a working order on the pairing side may
   *  keep (a bid at most `bid`, an ask at least `ask`; the order manager's tolerance never keeps one past it), and the sides
   *  held back to it that skip the queue race (MM_PC_RACE=off). Missing = no cap. */
  pcLim?: { bid: number | null; ask: number | null; rest: { bid: boolean; ask: boolean } };
  steps: Step[];
}

export type QuoteCfg = Pick<typeof CFG, "halfSpread" | "quoteFromSec" | "quoteUntilLeftSec" |
  "orderSize" | "maxPosition" | "skewAtMax" | "reduceOnlyLeftSec"> &
  Partial<Pick<typeof CFG, "flowFvScale" | "flowFvScaleRise" | "flowFvScaleFall">> & {
  /** null = no pull rule (v4). */
  pullMove: number | null;
  minEdge?: number | null; maxMove2s?: number | null;
  policy?: Policy;
  /** v2 edge rules; absent = v1 (the edge test on both sides, reduce-only included). */
  /** signal "fast" (v2: FV − mid less its slow part) or "lead" (v3: the anchored lead, with leadPull). */
  v2?: { exitBlock: number; entryLam: number; debias: boolean; edgeKeep: number; pairLockMin: number | null;
         signal: "fast" | "lead"; leadPull: number | null } | null;
};

/** The window's quoting policy: MM_POLICY=ab alternates by 5-minute slot (even v2, odd v1). */
export function policyFor(startTs: number, mode: (typeof CFG)["quotePolicy"] = CFG.quotePolicy): Policy {
  return mode === "ab" ? (Math.floor(startTs / 300) % 2 === 0 ? "v2" : "v1") : mode;
}

/** What a window ran, for the index and the dashboard's per-setup columns: the policy, "+queue" with the order
 *  manager's queue retention (half spread 0.5¢, tolerance band, stay at the touch), "+pair" with the v2/v3
 *  pair-lock (both 2026-10-10), "+take" with v4's takes and "+cap<N>" when the cap N counts the orders still cancelling
 *  (MM_CAP_PENDING, 2026-10-20), "+guard" with a tail-guard rule on (guard.ts, 2026-10-20). */
export function quoteTag(policy: Policy, cfg: typeof CFG = CFG): string {
  const pair = (policy === "v2" || policy === "v3") && cfg.pairLockMin != null;
  const flow = isV4(policy) && cfg.v4FlowImb != null, rebal = isV4(policy) && cfg.v4RebalNet != null;
  const take = flow && rebal ? "+take" : flow ? "+flow" : rebal ? "+rebal" : "";
  const race = isV4(policy) && (cfg.raceLevel != null || cfg.raceShare != null);
  const outbid = isV4(policy) && cfg.raceOutbid;
  return policy + (cfg.tolerateTicks > 0 || cfg.stayAtTouch ? "+queue" : "") + (pair ? "+pair" : "") + take + (race ? "+race" + (cfg.raceOnBook ? "+rob" : "") : "") + (race && cfg.raceInflight ? "+rif" : "") + (outbid ? "+outbid" : "") +
    (cfg.capPending ? `+cap${cfg.maxPosition}` : "") + (isV4(policy) && guardOn(cfg) ? "+guard" : "") + (isV4(policy) && pcOn(cfg) ? "+pc" : "") +
    (isV4(policy) && xsOn(cfg) ? "+xs" : "") + (isV4(policy) && swOn(cfg) ? "+swept" : "") +
    (cfg.cancelDelayMs > 0 ? `+cd${cfg.cancelDelayMs}` : "") + (isV4(policy) && cfg.joinMaxSh != null ? `+jmax${cfg.joinMaxSh}` : "") +
    (isV4(policy) && cfg.joinRel != null ? `+jrel${Math.round(cfg.joinRel * 100)}${cfg.joinRefMs !== 30_000 ? `w${cfg.joinRefMs / 1000}` : ""}` : "") +
    (isV4(policy) && cfg.lock.pct != null && cfg.lock.pct > 0 ? `+lock${Math.round(cfg.lock.pct * 100)}` : "") +
    (isV4(policy) && cfg.lock.pxF != null && cfg.lock.pxF > 0 ? `+lpx${Math.round(cfg.lock.pxF * 100)}n${cfg.lock.pxMinNet}` : "") +
    (isV4(policy) && cfg.v4ReduceOnlyLeftSec != null && cfg.v4ReduceOnlyLeftSec > 0 ? `+ro${cfg.v4ReduceOnlyLeftSec}` : "");
}

/** Whether the sweep rules act (sweep.ts; tag "+swept", not "+sw": the sweep fill model's "+sweep" starts with that): at least one trigger and one action. */
export function swOn(cfg: typeof CFG = CFG): boolean {
  const g = cfg.sw;
  const trig = g.jumpBps != null || g.move != null || g.fill || g.tv != null;
  const act = g.back > 0 || g.backK > 0 || g.centre === "cons" || g.size < 1;
  return trig && act;
}

/** Whether any excess trigger is on (excess.ts; tag "+xs"). */
export function xsOn(cfg: typeof CFG = CFG): boolean {
  const g = cfg.xs;
  return g.edge != null || g.jumpBps != null || g.lateSec != null || g.stopLoss != null;
}

/** Whether any tail-guard rule is on (guard.ts; tag "+guard"). */
export function guardOn(cfg: typeof CFG = CFG): boolean {
  const g = cfg.guard;
  return g.whipTv != null || g.gammaPull != null || g.jumpBps != null || g.invStopNet != null || g.capVolTv != null;
}

/** Whether any pair-cost rule is on (paircost.ts; tag "+pc"). */
export function pcOn(cfg: typeof CFG = CFG): boolean {
  const g = cfg.pc;
  return g.target != null || g.stop != null || g.widen != null || g.holdP != null;
}

/** Whether a window quotes around the flow FV (model/flowFv.ts): FLOW_FV=on, or ab = even 5-minute slots. v4 only. */
export function flowFor(startTs: number, cfg: typeof CFG = CFG): boolean {
  if (!isV4(policyFor(startTs, cfg.quotePolicy)) || cfg.flowFv === "off") return false;
  return cfg.flowFv === "on" || Math.floor(startTs / 300) % 2 === 0;
}

/** Whether a window also decides between frames (MM_DECIDE_STEP_MS > 0; engine.decide). v4 only. */
export function fastFor(startTs: number, cfg: typeof CFG = CFG): boolean {
  return isV4(policyFor(startTs, cfg.quotePolicy)) && cfg.decideStepMs > 0;
}

/** A window's setup tag: quoteTag ("pair" with PAIR_TRADE=on: no market making, pairTrader.ts; "follow-ncrace" / "-nc" /
 *  "-race" with FOLLOW_TRADE=on, follow.ts), plus "+ffv" when it quotes
 *  around the flow FV ("+ffv+kr100+kf250" with per-side scales FLOW_FV_SCALE_RISE / _FALL off FLOW_FV_SCALE) and "+10ms" (the step) when it also decides between frames ("+10ms+evbook" / "+evall" when also on input
 *  changes, MM_DECIDE_EVENTS; then "+fresh" with the model FV recomputed at each step, MM_DECIDE_FV). Paper on the sweep model ends "+sweep",
 *  after "+lat" / "+latbusy" when its venue times are drawn (PAPER_SWEEP_LAT), so tags ending "+sweep" still match; "+ec"
 *  between them with PAPER_EARLY_CANCEL, "+nh" before "+sweep" with PAPER_TAKER_HOLD=off, "+nb3" ("+nb" for the twin288 table) right after "+lat"
 *  with PAPER_NEWBEST_LAT (on by default since 2026-11-09). Live ends "+live", "+live+ec" with LIVE_EARLY_CANCEL, then "+cc<N>"
 *  with LIVE_CANCEL_COPIES > 1 and "+own" with LIVE_CANCEL_HTTP=own. quoteTag's "+race" is "+race+rob" with MM_RACE_ON_BOOK. */
export function windowTag(startTs: number, cfg: typeof CFG = CFG): string {
  const lat = cfg.paperSweep.lat ? (cfg.paperSweep.lat.mode === "busy" ? "+latbusy" : "+lat") + (cfg.paperSweep.lat.sweptCancel === "1023" ? "+sc1023" : "") +
    (cfg.paperSweep.lat.newBest ? (cfg.paperSweep.lat.newBestName === "twin288" ? "+nb" : "+nb3") : "") : "";
  const ks = (k: number, p: string) => (k !== cfg.flowFvScale ? `+${p}${Math.round(k * 100)}` : "");
  return (cfg.follow.on ? `follow-${cfg.follow.kinds.nocancel ? "nc" : ""}${cfg.follow.kinds.race ? "race" : ""}` : cfg.pair.on ? "pair" : quoteTag(policyFor(startTs, cfg.quotePolicy), cfg)) + (flowFor(startTs, cfg) ? "+ffv" : "") +
    (flowFor(startTs, cfg) && !cfg.pair.on && !cfg.follow.on ? ks(cfg.flowFvScaleRise, "kr") + ks(cfg.flowFvScaleFall, "kf") : "") +
    (fastFor(startTs, cfg) ? `+${cfg.decideStepMs}ms` : "") + (fastFor(startTs, cfg) && !cfg.pair.on && !cfg.follow.on && cfg.decideEvents !== "off" ? `+ev${cfg.decideEvents}` : "") +
    (fastFor(startTs, cfg) && cfg.decideFv === "fresh" ? "+fresh" : "") + (cfg.regime.on && cfg.hourRegime.mode !== "on" ? "+rg" : "") + (cfg.hourRegime.mode === "on" ? "+hr" : "") +
    (cfg.mode === "live" ? `+live${cfg.liveEarlyCancel ? "+ec" : ""}${cfg.liveCancelCopies > 1 ? `+cc${cfg.liveCancelCopies}` : ""}${cfg.liveCancelHttp === "own" ? "+own" : ""}` : cfg.paperFillModel === "sweep" ? `${lat}${lat && cfg.paperSweep.earlyCancel ? "+ec" : ""}${cfg.paperSweep.hold === false ? "+nh" : ""}+sweep` : "");
}

/** The setup's short name the dashboard shows (its per-setup columns and the window list): MM_TAG when set (e.g. "v6"),
 *  else the full windowTag. The full tag is still recorded in every window (tools filter on its parts: "+live", "nh"). */
export function windowName(startTs: number, cfg: typeof CFG = CFG): string {
  return cfg.tagName || windowTag(startTs, cfg);
}

/** The quoter config a policy runs with (cert has its own: certainty.certCfg). */
export function quoteCfg(policy: Exclude<Policy, "cert">, cfg: typeof CFG = CFG): QuoteCfg {
  if (policy === "v1") return { ...cfg, policy, v2: null };
  if (isV4(policy)) {
    return { ...cfg, policy, v2: null, minEdge: null, maxMove2s: null, pullMove: null,
      quoteFromSec: cfg.v4FromSec, quoteUntilLeftSec: cfg.v4QuoteUntilLeftSec, reduceOnlyLeftSec: cfg.v4ReduceOnlyLeftSec ?? 0 };
  }
  return { ...cfg, policy, reduceOnlyLeftSec: cfg.v2ReduceOnlyLeftSec,
    v2: { exitBlock: cfg.exitBlock, entryLam: cfg.entryLam, debias: cfg.edgeSlowSec != null, edgeKeep: Math.min(cfg.minEdge ?? 0, cfg.minEdgeKeep),
          pairLockMin: cfg.pairLockMin, signal: policy === "v3" ? "lead" : "fast", leadPull: policy === "v3" ? cfg.leadPull : null } };
}

const c = (x: number) => (x * 100).toFixed(1) + "¢";
const sc = (x: number) => (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(2) + "¢";
const sh = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(Number.isInteger(x) ? 0 : 1);

export function makeQuote(x: QuoteIn, cfg: QuoteCfg = CFG): Quote {
  const steps: Step[] = [];
  const add = (k: string, v: string, s: StepState = "info") => { steps.push({ k, v, s }); };
  const policy = cfg.policy ?? null;
  const none = (why: string, k: string): Quote => {
    add(k, why, "off");
    return { policy, bid: null, ask: null, bidSize: 0, askSize: 0, center: x.center, skew: 0, reservation: null, why, off: { bid: why, ask: why }, steps };
  };

  if (cfg.policy === "v1") add("policy", `v1 · the edge on both sides, reduce-only from ${cfg.reduceOnlyLeftSec}s before the close`);
  else if (cfg.policy === "v2" && cfg.v2) {
    add("policy", `v2 · ${cfg.v2.debias ? "de-biased" : "raw"} edge to add, exits unless ${c(cfg.v2.exitBlock)} against, reduce-only from ${cfg.reduceOnlyLeftSec}s`);
  } else if (cfg.policy === "v3" && cfg.v2) {
    add("policy", `v3 · follow the market; add only when the model moved first (lead ≥ ${c(cfg.minEdge ?? 0)})` +
      `${cfg.v2.leadPull != null ? `, pull the side a ${c(cfg.v2.leadPull)} lead runs into` : ""}, reduce-only from ${cfg.reduceOnlyLeftSec}s`);
  } else if (isV4(cfg.policy)) {
    add("policy", `${cfg.policy}${cfg.policy === "v5" ? " (v4 + tail guard)" : ""} · norm1e69: Up and Down bids at the touch around the anchored FV, skewed by inventory, ` +
      `${cfg.quoteFromSec}s after the open to ${cfg.quoteUntilLeftSec}s before the close; no edge filter, no pull`);
  }
  if (x.center == null) return none("no fair value", "centre");
  add("centre", `${x.centerSrc} ${c(x.center)}`);
  if (!x.bookReady) return none("no live book (never quote blind)", "book");
  if (x.elapsed < cfg.quoteFromSec) return none(`opening: quotes from ${cfg.quoteFromSec}s`, "window");
  if (x.left < cfg.quoteUntilLeftSec) return none(`closing: none in the last ${cfg.quoteUntilLeftSec}s`, "window");
  if (cfg.maxMove2s != null) {
    if (x.move2s != null && Math.abs(x.move2s) > cfg.maxMove2s) return none(`market moving: FV ${sc(x.move2s)} in 2 s > ${c(cfg.maxMove2s)}`, "motion");
    add("motion", x.move2s == null ? "no 2 s FV history yet" : `FV ${sc(x.move2s)} in 2 s, within ±${c(cfg.maxMove2s)}`, "ok");
  } else add("motion", `gate off (${isV4(cfg.policy) ? cfg.policy : "MM_MAX_MOVE_2S=off"})${x.move2s == null ? "" : `: FV ${sc(x.move2s)} in 2 s`}`, "ok");

  // ---- inventory skew ----
  const p = x.center, frac = Math.max(-1, Math.min(1, x.net / cfg.maxPosition));
  const skew = cfg.skewAtMax * frac * (p * (1 - p)) / 0.25;
  const res = p - skew;
  add("inventory", `net ${sh(x.net)} sh · ${Math.abs(frac * 100).toFixed(0)}% of the ±${cfg.maxPosition} limit`, Math.abs(frac) >= 1 ? "warn" : "info");
  add("skew", x.net ? `${sc(-skew)} → reservation ${c(res)}` : `none (flat) → reservation ${c(res)}`);

  // ---- per-side flow scale: each bid's centre moves (k − FLOW_FV_SCALE) × pred off the flow FV, k = the RISE scale for
  //      the bid on the token pred says will rise (Up bid when pred > 0), FALL for the other ----
  const k0 = cfg.flowFvScale, kRise = cfg.flowFvScaleRise ?? k0, kFall = cfg.flowFvScaleFall ?? k0;
  let resB = res, resA = res;
  if (x.flowPred != null && x.flowPred !== 0 && k0 != null && kRise != null && kFall != null && (kRise !== k0 || kFall !== k0)) {
    const up = x.flowPred > 0, sh2 = (k: number) => ((k - k0) * x.flowPred!) / 100;
    const clip = (v: number) => Math.min(0.999, Math.max(0.001, v));
    resB = clip(p + sh2(up ? kRise : kFall)) - skew;
    resA = clip(p + sh2(up ? kFall : kRise)) - skew;
    add("flow scale", `pred ${x.flowPred >= 0 ? "+" : "−"}${Math.abs(x.flowPred).toFixed(2)}¢ · ${up ? "Up" : "Down"} rising: ` +
      `Up bid ×${up ? kRise : kFall} → ${c(resB)}, Down bid ×${up ? kFall : kRise} → ${c(resA)} (centre ×${k0})`);
  }

  // ---- spread, ticks, post-only ----
  const tick = x.tick, r = (v: number) => Math.round(v * 1e4) / 1e4, eps = 1e-9, hs = cfg.halfSpread;
  let b = r(Math.floor((resB - hs) / tick + eps) * tick);
  let a = r(Math.ceil((resA + hs) / tick - eps) * tick);
  add("spread", `±${c(hs)} on the ${c(tick)} grid → ${c(b)} / ${c(a)}`);
  const why: string[] = [];
  const off: Quote["off"] = { bid: null, ask: null };
  const po: string[] = [];
  const held = { bid: false, ask: false };
  if (x.bestAsk != null && b >= x.bestAsk - eps) { b = r(x.bestAsk - tick); held.bid = true; po.push(`Up bid held under the best Up ask ${c(x.bestAsk)}`); }
  if (x.bestBid != null && a <= x.bestBid + eps) { a = r(x.bestBid + tick); held.ask = true; po.push(`Down bid held under the best Down ask ${c(1 - x.bestBid)}`); }
  add("post-only", po.length ? po.join(" · ") : `clear of ${x.bestBid != null ? c(x.bestBid) : "—"} / ${x.bestAsk != null ? c(x.bestAsk) : "—"}`, po.length ? "warn" : "ok");
  why.push(...po);
  let bid: number | null = b >= tick - eps && b <= 1 - 2 * tick + eps ? b : null;
  let ask: number | null = a >= 2 * tick - eps && a <= 1 - tick + eps ? a : null;
  if (bid == null) { why.push(off.bid = "Up bid outside the 1¢–98¢ range"); add("range", off.bid, "off"); }
  if (ask == null) { why.push(off.ask = "Down bid outside the 1¢–98¢ range"); add("range", off.ask, "off"); }
  if (bid != null && ask != null && ask - bid < tick - eps) ask = r(bid + tick);

  // ---- pull rule ----
  if (cfg.pullMove == null) {
    add("pull", `off (v4 quotes through moves)${x.move2s == null ? "" : `: FV ${sc(x.move2s)} in 2 s`}`, "ok");
  } else if (x.move2s != null && x.move2s >= cfg.pullMove) {
    ask = null; why.push(off.ask = `Down bid pulled: FV ${sc(x.move2s)} in 2 s`); add("pull", `FV ${sc(x.move2s)} in 2 s ≥ ${c(cfg.pullMove)} → Down bid pulled`, "off");
  } else if (x.move2s != null && x.move2s <= -cfg.pullMove) {
    bid = null; why.push(off.bid = `Up bid pulled: FV ${sc(x.move2s)} in 2 s`); add("pull", `FV ${sc(x.move2s)} in 2 s ≥ ${c(cfg.pullMove)} → Up bid pulled`, "off");
  } else {
    add("pull", x.move2s == null ? "no 2 s FV history yet" : `FV ${sc(x.move2s)} in 2 s, under ${c(cfg.pullMove)}`, "ok");
  }

  // ---- lead pull (v3): the market follows a model-first move, so the side it runs into goes ----
  const lp = cfg.v2?.leadPull ?? null;
  if (lp != null) {
    const L = x.lead ?? null;
    if (L != null && L >= lp) {
      const was = ask != null;
      if (was) { ask = null; why.push(off.ask = `Down bid pulled: the model moved first, lead ${sc(L)}`); }
      add("lead pull", `lead ${sc(L)} ≥ ${c(lp)} → Down bid pulled${was ? "" : " (already off)"}`, "off");
    } else if (L != null && L <= -lp) {
      const was = bid != null;
      if (was) { bid = null; why.push(off.bid = `Up bid pulled: the model moved first, lead ${sc(L)}`); }
      add("lead pull", `lead ${sc(L)} ≤ −${c(lp)} → Up bid pulled${was ? "" : " (already off)"}`, "off");
    } else add("lead pull", L == null ? "no lead (book not good)" : `lead ${sc(L)}, under ${c(lp)}`, "ok");
  }

  // ---- edge filter: v1 only the side the model says the mid is wrong on; v2 entries by the de-biased
  //      edge, exits unless it is strongly against them ----
  const ro = x.left < cfg.reduceOnlyLeftSec;
  /** v2: a side quoted only because it reduces |net| — sized to flatten, never to flip. */
  const exitOnly = { bid: false, ask: false };
  // v2 pair-lock takes over the reducing side (below): the edge step names it, the pair step prices it
  const lockMin = cfg.v2?.pairLockMin ?? null;
  // in reduce-only the reducing side flattens at the quote target instead
  const pairOn = lockMin != null && !ro && x.heldAvg != null && Math.abs(x.net) >= x.minSize;
  if (cfg.minEdge != null) {
    const v2 = cfg.v2 ?? null, isLead = v2?.signal === "lead";
    // v3: the anchored lead; v1/v2: the model's FV − mid (v2 less its slow part)
    const g = isLead ? x.lead ?? null : x.fv != null && x.mid != null ? x.fv - x.mid : null;
    const slow = !isLead && v2?.debias && x.edgeSlow != null ? x.edgeSlow : 0;
    const e = g == null ? null : g - slow;
    if (e == null) {
      if (bid != null) off.bid = "no FV − mid to judge the edge";
      if (ask != null) off.ask = "no FV − mid to judge the edge";
      bid = null; ask = null; why.push("edge unknown");
      add("edge", isLead ? "no lead (no good book or anchored FV): nothing added" : "no two-sided mid: edge unknown, nothing quoted", "off");
    } else if (v2) {
      const v = (p * (1 - p)) / 0.25;
      // dead band: a side already working stays on down to edgeKeep; a new one needs minEdge
      const me = cfg.minEdge, base = (on: boolean | undefined) => (on ? Math.min(me, v2.edgeKeep) : me);
      const needB = base(x.working?.bid) + v2.entryLam * Math.max(0, frac) * v;
      const needA = base(x.working?.ask) + v2.entryLam * Math.max(0, -frac) * v;
      const inB = e >= needB - 1e-12, inA = -e >= needA - 1e-12;
      const outB = x.net < 0 && (ro || -e < v2.exitBlock - 1e-12), outA = x.net > 0 && (ro || e < v2.exitBlock - 1e-12);
      exitOnly.bid = outB && !inB; exitOnly.ask = outA && !inA;
      const held = (side: string) => `exit held: edge ${sc(e)} is ${c(v2.exitBlock)} or more against the ${side}`;
      if (!inB && !outB && bid != null) { off.bid = x.net < 0 ? held("Up bid") : `edge ${sc(e)}, an Up bid needs ≥ +${c(needB)}`; bid = null; }
      if (!inA && !outA && ask != null) { off.ask = x.net > 0 ? held("Down bid") : `edge ${sc(e)}, a Down bid needs ≤ −${c(needA)}`; ask = null; }
      // a side that reduces |net| is an exit (passing the adding test too only lifts its flatten-only size cap)
      const role = (reduces: boolean, inn: boolean, out: boolean, need: string) =>
        reduces ? (pairOn ? "pair-lock" : inn || out ? (ro ? "exit (reduce-only)" : "exit") : `exit held (edge ${c(v2.exitBlock)}+ against)`)
          : inn ? "adds" : `off (adding needs ${need})`;
      const sides = `Up bid ${role(x.net < 0, inB, outB, `≥ +${c(needB)}`)} · Down bid ${role(x.net > 0, inA, outA, `≤ −${c(needA)}`)}`;
      const band = x.working?.bid || x.working?.ask ? ` · a working side stays on down to ${c(Math.min(me, v2.edgeKeep))}` : "";
      const sig = isLead ? `lead (FV anchored − mid) ${sc(e)}` : `FV − mid ${sc(g!)}${slow ? ` − slow ${sc(slow)}` : ""} = ${sc(e)}`;
      add("edge", `${sig} → ${sides}${band}`, inB || inA || outB || outA ? "ok" : "off");
      if (!(inB || outB) || !(inA || outA)) why.push(`edge ${sc(e)}: ${sides}`);
    } else {
      const okB = e >= cfg.minEdge - 1e-12, okA = -e >= cfg.minEdge - 1e-12;
      if (!okB && bid != null) { off.bid = `edge: FV − mid ${sc(e)}, an Up bid needs ≥ +${c(cfg.minEdge)}`; bid = null; }
      if (!okA && ask != null) { off.ask = `edge: FV − mid ${sc(e)}, a Down bid needs ≤ −${c(cfg.minEdge)}`; ask = null; }
      const v = okB ? "Up bid only" : okA ? "Down bid only" : "neither side";
      add("edge", `FV ${c(x.fv!)} − mid ${c(x.mid!)} = ${sc(e)} (±${c(cfg.minEdge)} needed) → ${v}`, okB || okA ? "ok" : "off");
      if (!okB || !okA) why.push(`edge ${sc(e)}: ${v}`);
    }
  }

  // ---- pair-lock (v2/v3): the other token's bid, priced to lock ≥ lockMin a pair against the held average cost ----
  const pair = { bid: false, ask: false };
  if (pairOn) {
    const avg = x.heldAvg!, held = `${sh(Math.abs(x.net))} ${x.net > 0 ? "Up" : "Down"} @ ${c(avg)}`;
    if (x.net > 0) {
      // long Up: a Down bid at 1 − a locks a − avg; the best passive price is the Up ask a tick over the best Up bid
      const lockPx = r(Math.ceil((avg + lockMin!) / tick - eps) * tick);
      const touch = x.bestBid != null ? r(x.bestBid + tick) : null;
      const a2 = touch != null ? Math.max(touch, lockPx) : lockPx, best = touch != null && Math.abs(a2 - touch) < eps;
      if (a2 >= 2 * tick - eps && a2 <= 1 - tick + eps) {
        ask = a2; off.ask = null; pair.ask = true;
        add("pair", `${held} → Down bid @ ${c(r(1 - a2))} locks ${sc(a2 - avg)} a pair` +
          (best ? ` at the best price` : ` · resting at the lock price (the best Down bid now would lock ${touch != null ? sc(touch - avg) : "—"})`),
          best ? "ok" : "info");
      } else { off.ask = `pair: the price ${c(r(1 - a2))} is outside 1¢–98¢`; ask = null; add("pair", `${held}: ${off.ask}`, "off"); }
    } else {
      // long Down: an Up bid at b locks 1 − avg − b; the best passive price is a tick under the best Up ask
      const lockPx = r(Math.floor((1 - avg - lockMin!) / tick + eps) * tick);
      const touch = x.bestAsk != null ? r(x.bestAsk - tick) : null;
      const b2 = touch != null ? Math.min(touch, lockPx) : lockPx, best = touch != null && Math.abs(b2 - touch) < eps;
      if (b2 >= tick - eps && b2 <= 1 - 2 * tick + eps) {
        bid = b2; off.bid = null; pair.bid = true;
        add("pair", `${held} → Up bid @ ${c(b2)} locks ${sc(1 - avg - b2)} a pair` +
          (best ? ` at the best price` : ` · resting at the lock price (the best Up bid now would lock ${touch != null ? sc(1 - avg - touch) : "—"})`),
          best ? "ok" : "info");
      } else { off.bid = `pair: the price ${c(b2)} is outside 1¢–98¢`; bid = null; add("pair", `${held}: ${off.bid}`, "off"); }
    }
  }

  // ---- size: position limit, then reduce-only near the close ----
  const fl = (v: number) => Math.max(0, Math.floor(v + 1e-9));
  let bs = fl(Math.min(cfg.orderSize, cfg.maxPosition - x.net));
  let as = fl(Math.min(cfg.orderSize, cfg.maxPosition + x.net));
  const lim: string[] = [];
  if (bs < cfg.orderSize) lim.push(`Up bid cut to ${bs} (room to +${cfg.maxPosition})`);
  if (as < cfg.orderSize) lim.push(`Down bid cut to ${as} (room to −${cfg.maxPosition})`);
  if (exitOnly.bid && bid != null && bs > -x.net) { bs = fl(-x.net); lim.push(`Up bid cut to ${bs}: an exit flattens, never flips`); }
  if (exitOnly.ask && ask != null && as > x.net) { as = fl(x.net); lim.push(`Down bid cut to ${as}: an exit flattens, never flips`); }
  if (pair.bid) { bs = fl(-x.net); lim.push(`pair Up bid ${bs}: the whole position`); }
  if (pair.ask) { as = fl(x.net); lim.push(`pair Down bid ${as}: the whole position`); }
  add("limit", lim.length ? lim.join(" · ") : `${cfg.orderSize} a side fits inside ±${cfg.maxPosition}`, lim.length ? "warn" : "ok");
  if (ro) {
    if (x.net > 0) { bs = 0; as = fl(Math.min(as, x.net)); }
    else if (x.net < 0) { as = 0; bs = fl(Math.min(bs, -x.net)); }
    else { bs = 0; as = 0; }
    const v = x.net > 0 ? `Down bid only, ${as} to pair off the Up` : x.net < 0 ? `Up bid only, ${bs} to pair off the Down` : "flat, nothing to reduce";
    add("reduce-only", `last ${cfg.reduceOnlyLeftSec}s: ${v}`, "warn");
    why.push(`reduce-only: ${v}`);
    if (bs === 0 && bid != null) off.bid = `reduce-only: ${v}`;
    if (as === 0 && ask != null) off.ask = `reduce-only: ${v}`;
  }
  const small = (n: number, exit: boolean) => (exit ? `exit: ${n} sh to flatten, under the ${x.minSize} minimum` : `${n} sh left under ±${cfg.maxPosition} (min ${x.minSize})`);
  if (bid != null && bs < x.minSize) { bid = null; off.bid ??= small(bs, exitOnly.bid); if (!why.some((w) => w.startsWith("reduce-only"))) why.push(`Up bid off: ${off.bid}`); }
  if (ask != null && as < x.minSize) { ask = null; off.ask ??= small(as, exitOnly.ask); if (!why.some((w) => w.startsWith("reduce-only"))) why.push(`Down bid off: ${off.ask}`); }
  if (bid == null) bs = 0;
  if (ask == null) as = 0;

  steps.push(targetStep(bid, bs, ask, as));
  return { policy, bid, ask, bidSize: bs, askSize: as, center: x.center, skew, reservation: res, why: why.length ? why.join(" · ") : "quoting both sides", off, held, steps };
}

export function targetStep(bid: number | null, bs: number, ask: number | null, as: number): Step {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  const out = bid == null && ask == null ? "no quote"
    : `${bid != null ? `Up bid ${bs} @ ${c(bid)}` : "no Up bid"} · ${ask != null ? `Down bid ${as} @ ${c(r(1 - ask))} (the Up ask at ${c(ask)})` : "no Down bid"}`;
  return { k: "target", v: out, s: bid == null && ask == null ? "off" : bid == null || ask == null ? "warn" : "ok" };
}

/**
 * v4: fold the taker's decision into the quote. `token` is the token a take is buying (sent this frame or still in
 * flight). Its ask is our bid on the other token on the mirrored book (Up ask at a = Down bid at 1 − a), so that bid
 * is pulled: a real account would cross itself, and the flow the take follows is about to run that bid over. The
 * taker's steps go in before the target, which is restated.
 */
export function applyTake(q: Quote, token: Token | null, takeSteps: Step[]): Quote {
  const steps = q.steps.filter((s) => s.k !== "target");
  steps.push(...takeSteps);
  const out: Quote = { ...q, off: { ...q.off }, steps };
  const side = token === "UP" ? "ask" : token === "DOWN" ? "bid" : null;
  if (side && out[side] != null) {
    const why = token === "UP" ? "Down bid pulled: our Up take lifts the Up ask it mirrors" : "Up bid pulled: our Down take lifts the Down ask it mirrors";
    out[side] = null;
    if (side === "ask") out.askSize = 0; else out.bidSize = 0;
    out.off[side] = why;
    out.why = out.why === "quoting both sides" ? why : `${out.why} · ${why}`;
    steps.push({ k: "take pull", v: why, s: "off" });
  }
  steps.push(targetStep(out.bid, out.bidSize, out.ask, out.askSize));
  return out;
}
