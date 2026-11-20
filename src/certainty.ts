// cert — CERTAINTY MAKER (MM_POLICY=cert, knobs MM_CERT_*; it was "v5" / MM_V5_* from 2026-10-11 until 2026-10-22, when
// v5 became v4 + the tail guard). Late in the window, bid only the near-certain token, at the price a Glosten–Milgrom
// dealer would pay: what the token is worth GIVEN that someone chose to sell it to us. Nothing else is quoted.
//
//   when         from MM_CERT_FROM_LEFT_SEC (120 s) before the close to MM_CERT_UNTIL_LEFT_SEC (1 s) before it. Earlier
//                quoting (v1–v4, 2026-10-07 → 10-11) lost at every mid price; the loss was adverse selection.
//   favourite    the token both the model FV and the anchored FV put over 50¢. Its probability p is the LOWER of the
//                two: on 1,030 archived windows (180–300 s) the raw model FV is overconfident (FV ≥ 99.5¢ at 180–240 s
//                won 98.9%), the anchored FV less so, and min(FV, anchored) is calibrated: ≥ 99.5¢ won 99.85–99.96%.
//                Quoted only when p ≥ MM_CERT_MIN_P (99¢); p is capped at MM_CERT_P_CAP (99.9¢) for pricing and sizing,
//                since no bucket in the archive was more certain than that.
//   price        Glosten–Milgrom for a 0/1 payoff: when informed sellers (selling only a loser) come κ times as often
//                as uninformed ones, E[V | a sell] = p − κ·(1 − p) as p → 1. The bid sits MM_CERT_MIN_EDGE (0.3¢) under
//                it: bid = p − κ(1 − p) − edge, κ = MM_CERT_KAPPA (1.5). At p = 99.9¢ → 99.45¢; p = 99¢ → 97.2¢.
//                Replayed on the archive (fill at a random quoting frame, or at the worst one), every start time
//                and threshold tried settled +0.1 to +1.1¢ a share.
//   touch        at most MM_CERT_IMPROVE_TICKS (1) tick over the favourite's best bid: at the front of the queue, not
//                further up than that. Under it, the bid rests where E[V | sell] puts it. Post-only: under the
//                favourite's best ask. The tick is 1¢ until the CLOB announces 0.1¢ (tick_size_change, liveTick):
//                in most windows that comes only after the close, so it mostly joins the 99¢ bid.
//   speed bump   a delayed taker order (150 ms) cannot be cancelled; a resting maker order can. The bid re-prices
//                every frame as p moves, and is pulled outright when the favourite's model FV fell MM_CERT_PULL
//                (0.2¢) or more in 2 s.
//   size         MM_CERT_ORDER_SIZE (100) a bid, and the favourite held net is capped at MM_CERT_MAX_POS (200) and at a
//                flip budget: (1 − p) · price · shares ≤ MM_CERT_FLIP_BUDGET ($0.40), the expected loss of a flip.
//                At p = 99.9¢ that is the 200 cap; at 99.5¢ 81 shares; at 99¢ 41.
//   held         to settlement: no exits, no takes. If the favourite flips, the new one is bid on its own merits.
//
// The quote comes out in the quoter's Up-book terms: an Up favourite is the bid; a Down favourite is the ask at
// 1 − price, which the order manager sends as a Down bid.
import { CFG } from "./config.js";
import type { BookView } from "./feeds/pmBook.js";
import type { Quote, Step, StepState } from "./quoter.js";

export interface CertIn {
  /** Model FV and market-anchored FV of Up. */
  fv: number | null;
  fva: number | null;
  /** Model FV move over the last 2 s, Up terms. */
  move2s: number | null;
  elapsed: number;
  left: number;
  /** The tick in force now (liveTick). */
  tick: number;
  minSize: number;
  bookReady: boolean;
  /** The Up book's best bid / ask. The Down book is its mirror. */
  bestBid: number | null;
  bestAsk: number | null;
  /** Net Up shares held in this window: Up − Down. */
  net: number;
}

export interface CertCfg {
  fromLeftSec: number; untilLeftSec: number;
  minP: number; pCap: number; kappa: number; minEdge: number; improveTicks: number;
  pull: number | null;
  orderSize: number; maxPos: number; flipBudget: number;
}

export function certCfg(cfg: typeof CFG = CFG): CertCfg {
  return {
    fromLeftSec: cfg.certFromLeftSec, untilLeftSec: cfg.certUntilLeftSec, minP: cfg.certMinP, pCap: cfg.certPCap, kappa: cfg.certKappa,
    minEdge: cfg.certMinEdge, improveTicks: cfg.certImproveTicks, pull: cfg.certPull, orderSize: cfg.certOrderSize, maxPos: cfg.certMaxPos,
    flipBudget: cfg.certFlipBudget,
  };
}

/** The tick in force: the CLOB's `tick_size_change` for this market, else its listed tick. No price rule: the change
 *  fires at no fixed price or time (2026-10-11, 4,683 recorded windows: two thirds only after the close, and a "beyond
 *  96¢ / 4¢" rule fired a median 2 min before the real change). Orders off the grid are rejected; 1¢ prices are always
 *  on it. */
export function liveTick(marketTick: number, v: Pick<BookView, "tick">): number {
  return v.tick != null && v.tick > 0 ? v.tick : marketTick;
}

const c = (x: number) => (x * 100).toFixed(1) + "¢";
const c2 = (x: number) => (x * 100).toFixed(2) + "¢";
const sh = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(Number.isInteger(x) ? 0 : 1);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const fl = (v: number) => Math.max(0, Math.floor(v + 1e-9));
const EPS = 1e-9;

export function makeQuoteCert(x: CertIn, cfg: CertCfg): Quote {
  const steps: Step[] = [];
  const add = (k: string, v: string, s: StepState = "info") => { steps.push({ k, v, s }); };
  const out = (bid: number | null, ask: number | null, size: number, center: number | null, res: number | null, why: string, off: Quote["off"]): Quote => {
    steps.push({ k: "target", v: bid != null ? `Up bid ${size} @ ${c(bid)}` : ask != null ? `Down bid ${size} @ ${c(r4(1 - ask))} (the Up ask at ${c(ask)})` : "no quote",
      s: bid != null || ask != null ? "ok" : "off" });
    return { policy: "cert", bid, ask, bidSize: bid != null ? size : 0, askSize: ask != null ? size : 0, center, skew: 0, reservation: res, why, off, steps };
  };
  const none = (why: string, k: string, center: number | null = null): Quote => { add(k, why, "off"); return out(null, null, 0, center, null, why, { bid: why, ask: why }); };

  add("policy", `cert · certainty maker: bid only the near-certain token at E[V | a sell] − ${c(cfg.minEdge)}, ` +
    `${cfg.fromLeftSec}s → ${cfg.untilLeftSec}s before the close; held to settlement`);
  if (x.left > cfg.fromLeftSec) return none(`not yet: quotes from ${cfg.fromLeftSec}s before the close (${Math.ceil(x.left)}s left)`, "window");
  if (x.left < cfg.untilLeftSec) return none(`closing: none in the last ${cfg.untilLeftSec}s`, "window");
  if (!x.bookReady) return none("no live book (never quote blind)", "book");
  if (x.fv == null || x.fva == null) return none(`needs both FVs (model ${x.fv == null ? "—" : c(x.fv)}, anchored ${x.fva == null ? "—" : c(x.fva)})`, "favourite");

  // ---- favourite: the token both FVs put over 50¢, at the lower of the two ----
  const up = x.fv >= 0.5 && x.fva >= 0.5, dn = x.fv < 0.5 && x.fva < 0.5;
  if (!up && !dn) return none(`the model FV ${c(x.fv)} and the anchored FV ${c(x.fva)} disagree on the favourite`, "favourite", x.fv);
  const tok = up ? "Up" : "Down", tf = (p: number) => (up ? p : 1 - p);
  const pf = Math.min(tf(x.fv), tf(x.fva)), centerUp = up ? pf : 1 - pf;
  const fav = `${tok}: model ${c2(tf(x.fv))} · anchored ${c2(tf(x.fva))} → ${c2(pf)}`;
  if (pf < cfg.minP - EPS) return none(`${fav}, under the ${c(cfg.minP)} needed`, "favourite", centerUp);
  add("favourite", `${fav} (the lower)`, "ok");

  // ---- Glosten–Milgrom: what the favourite is worth once a seller has picked our bid ----
  const p = Math.min(pf, cfg.pCap), ev = p - cfg.kappa * (1 - p), g = ev - cfg.minEdge;
  add("value", `p ${c2(p)}${pf > cfg.pCap + EPS ? ` (capped from ${c2(pf)})` : ""} → E[V | sell] = p − ${cfg.kappa}·(1 − p) = ${c2(ev)} → bid ≤ ${c2(g)}`);
  const res = up ? ev : 1 - ev;

  // ---- price on the tick, against the favourite's own book ----
  const tick = x.tick;
  const fb = up ? x.bestBid : x.bestAsk != null ? r4(1 - x.bestAsk) : null;   // the favourite's best bid
  const fa = up ? x.bestAsk : x.bestBid != null ? r4(1 - x.bestBid) : null;   // ...and best ask
  let px = r4(Math.floor(g / tick + EPS) * tick);
  const book = `${tok} book ${fb != null ? c(fb) : "—"} / ${fa != null ? c(fa) : "—"} · tick ${c(tick)}`;
  if (fb != null && px > fb + cfg.improveTicks * tick + EPS) {
    px = r4(fb + cfg.improveTicks * tick);
    add("touch", `${book} → ${c(px)}: ${cfg.improveTicks} tick${cfg.improveTicks === 1 ? "" : "s"} over the best bid, no higher`, "ok");
  } else if (fb != null && px < fb - EPS) {
    add("touch", `${book} → ${c(px)}: the book bids more than E[V | sell] allows, so the bid rests behind it`, "warn");
  } else add("touch", `${book} → ${c(px)}${fb != null && Math.abs(px - fb) < EPS ? " (joins the best bid)" : fb != null ? " (improves the best bid)" : " (alone on its side)"}`, "ok");
  if (fa != null && px >= fa - EPS) {
    px = r4(fa - tick);
    add("post-only", `held a tick under the best ${tok} ask ${c(fa)} → ${c(px)}`, "warn");
  }
  if (px < tick - EPS || px > 1 - tick + EPS) return none(`the price ${c(px)} is outside ${c(tick)}–${c(1 - tick)}`, "range", centerUp);

  // ---- speed bump: the favourite's FV falling fast pulls the bid before a delayed taker can reach it ----
  const drop = x.move2s == null ? null : up ? -x.move2s : x.move2s;
  if (cfg.pull != null && drop != null && drop >= cfg.pull - EPS) return none(`pulled: the ${tok} FV fell ${c2(drop)} in 2 s (≥ ${c2(cfg.pull)})`, "pull", centerUp);
  add("pull", cfg.pull == null ? "off" : drop == null ? "no 2 s FV history yet" : `${tok} FV ${drop > 0 ? "−" : "+"}${c2(Math.abs(drop))} in 2 s, under ${c2(cfg.pull)}`, "ok");

  // ---- size: the position cap and the flip budget ----
  const held = up ? x.net : -x.net;
  const capFlip = cfg.flipBudget / Math.max(1e-6, (1 - p) * px);
  const cap = Math.min(cfg.maxPos, capFlip);
  const size = fl(Math.min(cfg.orderSize, cap - held));
  const lim = `holding ${sh(held)} ${tok} · cap ${fl(cap)} (${capFlip < cfg.maxPos ? `flip budget $${cfg.flipBudget.toFixed(2)} at (1 − p)·price ${c2((1 - p) * px)}` : `MM_CERT_MAX_POS ${cfg.maxPos}`})`;
  if (size < x.minSize) return none(`${lim}: ${size} sh left, under the ${x.minSize} minimum`, "size", centerUp);
  add("size", `${lim} → ${size}`, size < cfg.orderSize ? "warn" : "ok");

  const why = `${tok} favourite ${c2(pf)} · bid ${c(px)} vs E[V | sell] ${c2(ev)}`;
  const other = `cert bids only the favourite (${tok})`;
  return up ? out(px, null, size, centerUp, res, why, { bid: null, ask: other })
    : out(null, r4(1 - px), size, centerUp, res, why, { bid: other, ask: null });
}
