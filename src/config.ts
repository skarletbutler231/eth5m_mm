// Runtime configuration. Every knob is an env var with a default that works out of the box.
// A `.env` file in the project root is read at boot (see loadEnv) so pm2 needs no extra wiring.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CALM_CANCEL_MS, COPIES3_NEWBEST_PLACE_MS, SWEPT_CANCEL_MS_1023, TWIN_NEWBEST_PLACE_MS, type LatCfg } from "./trading/venueLatency.js";
import { peerFiles } from "./trading/peers.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** KEY=value lines of an env file (none if it is missing). */
function readEnvFile(f: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const q = m[2].match(/^(["'])(.*)\1/);                          // quoted: taken as is
    out.set(m[1], q ? q[2] : m[2].replace(/\s+#.*$/, ""));          // unquoted: a " # comment" tail is dropped
  }
  return out;
}

/** Under pm2 (pm_id and name set): this app's `env` in ecosystem.config.cjs as the file is now. null = not under pm2,
 *  or the app or the file can't be read. */
function pm2AppEnv(): Record<string, string> | null {
  const name = process.env.name;
  if (process.env.pm_id === undefined || !name) return null;
  try {
    const eco = createRequire(import.meta.url)(path.join(ROOT, "ecosystem.config.cjs"));
    const app = (eco?.apps ?? []).find((a: { name?: string } | null) => a?.name === name);
    if (!app) { console.error(`[env] no app "${name}" in ecosystem.config.cjs: pm2's saved env beats .env`); return null; }
    return Object.fromEntries(Object.entries(app.env ?? {}).map(([k, v]) => [k, String(v)]));
  } catch (e) {
    console.error(`[env] ecosystem.config.cjs unreadable (${(e as Error)?.message ?? e}): pm2's saved env beats .env`);
    return null;
  }
}

// Outside pm2, a var already in the process env beats .env (`PAIR_SIZE=3 npx tsx src/index.ts`). Under pm2 the files
// decide at every boot: pm2 saves an app's env at its first `pm2 start` and `pm2 restart` keeps it, so a key since
// removed from ecosystem.config.cjs stayed set and beat .env (2026-10-17: the live pair app ran PAIR_LEG1=taker and
// PAIR_MAKER_MS=500 against .env's maker and 1000; the paper one PAIR_LOOKBACK_MS=200 against 100, and no PAPER_TAKE_MS).
// So under pm2: the app's env in ecosystem.config.cjs, then .env for every other key, and a knob (.env.example) that
// neither sets is dropped from the saved env to its default; each change is logged. (A new interpreter still needs
// pm2 delete + start.)
function loadEnv(): void {
  const file = readEnvFile(path.join(ROOT, ".env")), app = pm2AppEnv();
  if (!app) {
    for (const [k, v] of file) if (process.env[k] === undefined) process.env[k] = v;
    return;
  }
  const changed: string[] = [], dropped: string[] = [];
  const show = (k: string, v: string) => (/KEY|SECRET|PASS/.test(k) ? "…" : v);         // no wallet key in the log
  const set = (k: string, v: string) => {
    const was = process.env[k];
    if (was !== undefined && was !== v) changed.push(`${k} ${show(k, was)} → ${show(k, v)}`);
    process.env[k] = v;
  };
  for (const [k, v] of file) if (!(k in app)) set(k, v);
  for (const [k, v] of Object.entries(app)) set(k, v);
  for (const k of readEnvFile(path.join(ROOT, ".env.example")).keys()) {
    if (file.has(k) || k in app || process.env[k] === undefined) continue;
    dropped.push(`${k}=${show(k, process.env[k]!)}`);
    delete process.env[k];
  }
  if (changed.length) console.log(`[env] pm2 app ${process.env.name}: pm2's saved env replaced by ecosystem.config.cjs / .env: ${changed.join(", ")}`);
  if (dropped.length) console.log(`[env] pm2 app ${process.env.name}: set in neither file, back to the default: ${dropped.join(", ")}`);
}
loadEnv();

const num = (k: string, d: number): number => {
  const v = Number(process.env[k]);
  return process.env[k] !== undefined && process.env[k] !== "" && Number.isFinite(v) ? v : d;
};
const str = (k: string, d: string): string => process.env[k] || d;
function mode(v: string): "paper" | "shadow" | "live" {
  if (v === "paper" || v === "shadow" || v === "live") return v;
  throw new Error(`MM_MODE=${v}: expected paper, shadow or live`);
}
/** A number, or null when the knob is set to "off". */
const numOff = (k: string, d: number): number | null => (str(k, "").toLowerCase() === "off" ? null : num(k, d));
/** A number that is off (null) unless set (or d when unset); a value that is not a number stops the boot instead of quietly
 *  meaning off. */
function optNum(k: string, d: number | null = null): number | null {
  const v = str(k, "").trim();
  if (v === "") return d;
  if (v.toLowerCase() === "off") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k}=${v}: expected a number or off`);
  return n;
}
function side(k: string, d: "both" | "adding" = "both"): "both" | "adding" {
  const v = str(k, d).toLowerCase();
  if (v === "both" || v === "adding") return v;
  throw new Error(`${k}=${v}: expected both or adding`);
}
function oneOf<T extends string>(k: string, vals: readonly T[], d: T): T {
  const v = str(k, d).toLowerCase();
  const hit = vals.find((x) => x === v);
  if (hit === undefined) throw new Error(`${k}=${v}: expected ${vals.join(" or ")}`);
  return hit;
}
const onOff = (k: string, d: "on" | "off"): boolean => oneOf(k, ["on", "off"] as const, d) === "on";

const POLICIES = ["v1", "v2", "v3", "v4", "v5", "cert", "ab"] as const;
const POLICY = POLICIES.find((p) => p === str("MM_POLICY", "v5")) ?? "v5";
/** v5 = v4 + the tail guard's adopted rules, which are its defaults (guard below); under any other policy they are off. */
const V5 = POLICY === "v5";

export const CFG = {
  port: num("PORT", 8040),
  host: str("LISTEN_HOST", "127.0.0.1"),
  /** The header's PAPER | LIVE switch links to this bot's other half on this port, same host (server.ts asks it for its
   *  status every 5 s). Default: a paper bot's PORT + 1, a live bot's PORT − 1 (8040/8041 market maker, 8042/8043 pair
   *  trade; the BTC bot has 8030-8035). "off", or MM_MODE=shadow, hides the switch. */
  twinPort: str("MM_MODE", "paper") === "shadow" ? null
    : numOff("TWIN_PORT", num("PORT", 8040) + (str("MM_MODE", "paper") === "live" ? -1 : 1)),
  dataDir: path.resolve(ROOT, str("DATA_DIR", "data")),

  /** Dashboard push cadence. Every frame is also a recorded sample, so this is the replay resolution too. */
  uiPushMs: num("UI_PUSH_MS", 100),

  // ---- fair value model ------------------------------------------------------------------------
  /** Prior for kappa = sigma_implied / sigma_base before any window is calibrated (7-day median 1.10). */
  kappaPrior: num("KAPPA_PRIOR", 1.10),
  /** Number of completed windows the kappa median runs over. */
  kappaWindows: num("KAPPA_WINDOWS", 20),
  /** Prior std (bps) of the settlement reconstruction error, until 120 live TWAP reports are scored. */
  epsPriorBps: num("EPS_PRIOR_BPS", 0.1),
  epsFloorBps: num("EPS_FLOOR_BPS", 0.05),
  /** Base sigma = sqrt(w*EWMA_fast + (1-w)*EWMA_slow) of 1 s Binance log-return variance. */
  volFastSec: num("VOL_HALF_LIFE_FAST_SEC", 120),
  volSlowSec: num("VOL_HALF_LIFE_SLOW_SEC", 1800),
  volFastWeight: num("VOL_FAST_WEIGHT", 0.5),
  /** Chainlink-vs-Binance oracle lag. "auto" = estimated live; a number pins it (ms). */
  oracleLag: str("ORACLE_LAG_MS", "auto"),
  oracleLagPriorMs: num("ORACLE_LAG_PRIOR_MS", 250),
  /** Coinbase <asset>-USD (asset.ts) top of book as a second nowcast venue. "off" = Binance only, as before. */
  cbFeed: str("CB_FEED", "on").toLowerCase() !== "off",
  /** Coinbase's weight in the nowcast blend. "auto" = calibrated live; a number in [0, 1] pins it (0 = Binance only). */
  cbWeight: str("NOWCAST_CB_WEIGHT", "auto"),
  /** Chainlink-vs-Coinbase lag. "auto" = calibrated live with the weight; a number pins it (ms). */
  cbLag: str("CB_LAG_MS", "auto"),
  /** Priors until the first live fit (one hour on 2026-10-09: weight 0.23-0.31, lag 0-500 ms). */
  cbWeightPrior: num("CB_WEIGHT_PRIOR", 0.25),
  cbLagPriorMs: num("CB_LAG_PRIOR_MS", 350),
  /** Numerical floor on sigma only (bps/sqrt s). Deliberately far below pmqb's 0.25 floor. */
  sigmaMinBps: num("SIGMA_MIN_BPS", 0.02),

  // ---- quoter -----------------------------------------------------------------------------------
  /** ± around the reservation, floored/ceiled to the tick. 0.5¢ joins the best bid in a 1¢ book; 1¢ sat a tick behind it. */
  halfSpread: num("MM_HALF_SPREAD", 0.005),
  /** Pull the side a Binance move is running into when FV moved more than this over the last 2 s. */
  pullMove: num("MM_PULL_MOVE", 0.005),
  quoteFromSec: num("MM_QUOTE_FROM_SEC", 15),
  quoteUntilLeftSec: num("MM_QUOTE_UNTIL_LEFT_SEC", 10),
  /** Edge filter: bid only when model FV ≥ mid + this, ask only when FV ≤ mid − this. "off" quotes both sides. */
  minEdge: numOff("MM_MIN_EDGE", 0.01),
  /** Motion gate: no quotes at all while |FV move over 2 s| exceeds this. "off" disables. */
  maxMove2s: numOff("MM_MAX_MOVE_2S", 0.003),

  // ---- quoting policy ---------------------------------------------------------------------------
  /** v5 (default since 2026-10-22) = v4 + the tail guard with the two rules the tailguard agent found: the vol cap
   *  (MM_CAP_VOL_TV 0.3) and the gamma pull on the side that adds to |net| (MM_GAMMA_PULL 0.6, MM_GAMMA_SIDE adding);
   *  v4 (2026-10-10 → 10-22) = norm1e69's book: both tokens bid at the touch, inventory skew, order-flow and rebalance
   *  takes (~85-95 fills a window; 20-share orders, takes off and cap 20 since); cert = the certainty maker ("v5" from
   *  2026-10-11 to 10-22): late in the window, bid only the near-certain token at its Glosten–Milgrom price (~5 fills a
   *  window); v3 = follow the market, add only when the model moved first (anchored lead); v2 = de-biased model edge for
   *  entries; v1 = the edge filter on both sides (legacy); ab = even 5-minute slots v2, odd v1. */
  quotePolicy: POLICY as (typeof POLICIES)[number],
  /** v3: pull the side a lead (FV anchored − mid) of at least this is running into. "off" disables. */
  leadPull: numOff("MM_LEAD_PULL", 0.005),
  /** v2: the edge is FV − mid less its EMA with this half-life (the persistent model bias). "off" = raw FV − mid. */
  edgeSlowSec: numOff("MM_EDGE_SLOW_SEC", 60),
  /** v2: a side that reduces |net| is quoted unless the edge is at least this far against it. */
  exitBlock: num("MM_EXIT_BLOCK", 0.02),
  /** v2 dead band: a side that already has a working order stays on while the edge is at least this (it turns on at MM_MIN_EDGE). */
  minEdgeKeep: num("MM_MIN_EDGE_KEEP", 0.005),
  /** v2: extra edge a side that adds to |net| needs at the position cap, for a 50¢ contract (scales with |net|/cap and p(1−p)). */
  entryLam: num("MM_ENTRY_LAM", 0.03),
  /** v2 pair-lock: while holding, the other token's bid is priced to lock at least this per pair against the held
   *  side's average cost: at the best price when that already locks it, else resting at the lock price. It needs
   *  no edge and ignores the pull rule. "off" = the v2 exit rules instead. */
  pairLockMin: numOff("MM_PAIR_LOCK_MIN", 0.05),
  /** v2: reduce-only from this many seconds before the close, with no edge test on the reducing side. */
  v2ReduceOnlyLeftSec: num("MM_V2_REDUCE_ONLY_LEFT_SEC", 60),

  // ---- v4: norm1e69's algorithm (2026-10-10 study of its 34,586 BTC-5m fills) --------------------------
  /** Quotes and takes start this many seconds after the open (norm1e69's first fill: median 11 s, 10th pct 5 s). */
  v4FromSec: num("MM_V4_FROM_SEC", 5),
  /** Maker quotes stop this many seconds before the close (norm1e69's maker fills stop at ~270 s). */
  v4QuoteUntilLeftSec: num("MM_V4_QUOTE_UNTIL_LEFT_SEC", 30),
  /** Closing only (README "Closing only from 120 s", 2026-11-12): from this many seconds before the close to the quote stop,
   *  only the side that reduces |net| is quoted, sized to flatten (never flip); flat = no quote. 180 = from 120 s elapsed.
   *  Off (default) = none. Tag "+ro<s>". */
  v4ReduceOnlyLeftSec: optNum("MM_V4_REDUCE_ONLY_LEFT_SEC"),
  /** Takes stop this many seconds before the close: when the 60 s settlement average starts, as norm1e69's do. */
  v4TakeUntilLeftSec: num("MM_V4_TAKE_UNTIL_LEFT_SEC", 60),
  /** Flow take: lift a token's ask when its L1 imbalance (bid − ask)/(bid + ask) is at least this (norm1e69's median
   *  at its takes: 0.68-0.78). "off" = none. */
  v4FlowImb: numOff("MM_V4_FLOW_IMB", 0.7),
  /** ...and that ask holds at most this many shares (norm1e69: median 100 at its takes, 450 at its maker fills). */
  v4FlowThin: num("MM_V4_FLOW_THIN", 100),
  /** ...unless the anchored FV puts the token more than this under the ask (the fair-value veto). */
  v4FvSlack: num("MM_V4_FV_SLACK", 0.01),
  /** Rebalance take: buy the short token at its ask when |net| reaches this. "off" = none. */
  v4RebalNet: numOff("MM_V4_REBAL_NET", 60),
  /** Minimum time between two flow takes: ~17 a window, near norm1e69's rate (a 2 s gap took one every 2 s and
   *  bled fees, dry run 2026-10-10). Rebalance takes only wait for the previous take to land. */
  v4FlowCooldownMs: num("MM_V4_FLOW_COOLDOWN_MS", 10_000),

  // ---- flow FV: the quote centre from order flow (model/flowFv.ts; 2026-10-12 study, README "Flow FV") -----------------
  /** v4 quotes (and its flow-take veto) centre on mid + FLOW_FV_SCALE × the model's predicted mid move over its horizon,
   *  instead of the anchored FV. on = every window; ab = even 5-minute slots (tag "+ffv"), odd ones keep the anchored FV;
   *  off = never. The prediction is computed and recorded in every window either way. */
  flowFv: (["on", "ab", "off"].includes(str("FLOW_FV", "off").toLowerCase()) ? str("FLOW_FV", "off").toLowerCase() : "off") as "on" | "ab" | "off",
  /** The model (tools/flowfv/export_model.py output), relative to the project root. */
  flowFvModel: path.resolve(ROOT, str("FLOW_FV_MODEL", "models/flowfv-h2.json")),
  /** Multiplier on the predicted move: 2 was best on the held-out days 10-02..10-04 (replay of v4). */
  flowFvScale: num("FLOW_FV_SCALE", 2),
  /** Per-side multipliers (2026-11-15, tools/bigmove/asym.py): the bid on the token the prediction says will rise (the Up bid
   *  when pred > 0, the Down bid when < 0) centres on mid + FLOW_FV_SCALE_RISE × pred, the other bid on mid +
   *  FLOW_FV_SCALE_FALL × pred. Unset = FLOW_FV_SCALE (one centre). Only the two bids: the flow FV itself (rows' ffv,
   *  the skew, takes, guard, the dashboard) stays mid + FLOW_FV_SCALE × pred. Tag "+kr<×100>" / "+kf<×100>" when they differ. */
  flowFvScaleRise: num("FLOW_FV_SCALE_RISE", num("FLOW_FV_SCALE", 2)),
  flowFvScaleFall: num("FLOW_FV_SCALE_FALL", num("FLOW_FV_SCALE", 2)),
  /** Binance USD-M perp bookTicker, the model's strongest input (the perp leads spot). "off" = no feed (its features
   *  go missing and the model degrades). */
  perpFeed: str("PERP_FEED", "on").toLowerCase() !== "off",
  /** CryptoStruct realtime relay of the Binance top of book (feeds/binance.ts, https://cryptostruct.com/docs/realtime.md).
   *  CRYPTOSTRUCT_FEEDS = which Binance feeds take it: "perp", "spot", "perp,spot" or off. Each one is a socket, and a key may
   *  hold 3 at a time per host across markets (paper + challenger + live on perp = 3). The direct socket is the fallback. */
  /** Chainlink source (feeds/rtds.ts). CL_FEED: "auto" = PolyBolt when POLYBOLT_API_KEY is set, else RTDS;
   *  "polybolt" | "rtds" to pin one. PolyBolt wants a CLOB L2 key (a feed-only one: node
   *  ../btc5m_mm_bot/tools/polybolt/feedkey.mjs; not the trading wallet's) and from 2026-11-30 the Chainlink API key
   *  (institutional.polymarket.com/request-chainlink-api-key). Without them on that date PolyBolt refuses → RTDS. */
  clFeed: str("CL_FEED", "auto").toLowerCase() as "auto" | "polybolt" | "rtds",
  polybolt: {
    apiKey: str("POLYBOLT_API_KEY", ""),
    secret: str("POLYBOLT_SECRET", ""),
    passphrase: str("POLYBOLT_PASSPHRASE", ""),
    chainlinkKey: str("CHAINLINK_API_KEY", ""),
  },
  cs: {
    /** The realtime API key (/account/realtime). In .env: a key exported only in the shell is dropped by loadEnv. */
    key: str("CRYPTOSTRUCT_REALTIME_API_KEY", ""),
    /** London is ~16 ms from this box (AWS eu-west-1); fra1 ~36 ms. Ports: 14004 binance_swap, 14003 binance_spot. */
    host: str("CRYPTOSTRUCT_HOST", "lon1.cryptostruct.com"),
    perp: /\bperp\b/.test(str("CRYPTOSTRUCT_FEEDS", "off").toLowerCase()),
    spot: /\bspot\b/.test(str("CRYPTOSTRUCT_FEEDS", "off").toLowerCase()),
    /** Unset = the asset's preset (asset.ts: BTCUSDT perp 67824; ETH 0); 0 = looked up in the instrument directory at boot. */
    perpId: optNum("CRYPTOSTRUCT_PERP_ID"),
    spotId: num("CRYPTOSTRUCT_SPOT_ID", 0),
  },
  /** Polymarket market sockets (pmBook.ts "Sockets"): each event is taken from whichever socket delivers it first. One
   *  connection at a time runs 50–90 ms behind another for whole windows (10% of paper/challenger windows, 10-28..29; the
   *  live run of 10-23 had 2 of 5), so 2 takes the faster. 1 = the single socket as before (no guard). */
  pmSockets: Math.max(1, Math.min(4, Math.round(num("PM_SOCKETS", 1)))),

  // ---- cert: certainty maker (certainty.ts, "v5" until 2026-10-22; 2026-10-11 study of 1,030 archived windows) ------
  /** Quotes start this many seconds before the close... */
  certFromLeftSec: num("MM_CERT_FROM_LEFT_SEC", 120),
  /** ...and stop this many seconds before it. */
  certUntilLeftSec: num("MM_CERT_UNTIL_LEFT_SEC", 1),
  /** The favourite's probability, the lower of the model FV and the anchored FV, must be at least this. */
  certMinP: num("MM_CERT_MIN_P", 0.99),
  /** ...and is capped here for pricing and sizing (min(FV, anchored) ≥ 99.5¢ won 99.85–99.96% late in the window). */
  certPCap: num("MM_CERT_P_CAP", 0.999),
  /** Glosten–Milgrom: informed sellers per uninformed one. E[V | a sell] = p − κ·(1 − p). */
  certKappa: num("MM_CERT_KAPPA", 1.5),
  /** The bid sits at least this under E[V | a sell]. */
  certMinEdge: num("MM_CERT_MIN_EDGE", 0.003),
  /** At most this many ticks over the favourite's best bid. */
  certImproveTicks: num("MM_CERT_IMPROVE_TICKS", 1),
  /** Speed bump: pull the bid when the favourite's model FV fell at least this in 2 s. "off" = re-pricing only. */
  certPull: numOff("MM_CERT_PULL", 0.002),
  /** Shares a bid. */
  certOrderSize: num("MM_CERT_ORDER_SIZE", 100),
  /** Cap on the favourite held net, shares. */
  certMaxPos: num("MM_CERT_MAX_POS", 200),
  /** ...and on its expected flip loss, (1 − p) · price · shares, USDC. */
  certFlipBudget: num("MM_CERT_FLIP_BUDGET", 0.4),

  // ---- queue race (v4; 2026-10-11 queue-value study on 4,669 recorded windows) -------------------------------
  /** Cancel a resting bid that joined an existing level once that level (the others at its price) falls below this share
   *  of its size when the order went live. "off" = none. */
  raceLevel: numOff("MM_RACE_LEVEL", 0.5),
  /** ...or once its side's share of the touch, level / (level + the opposite best), falls below this; and no new bid joins
   *  an existing level whose share is under it. "off" = none. */
  raceShare: numOff("MM_RACE_SHARE", 0.2),
  /** After a race cancel, that side does not rejoin the same price for this long. */
  raceHoldMs: num("MM_RACE_HOLD_MS", 1000),
  /** Cancel a bid once it is outbid: it was the best price of its book while live and is now behind it. "on" to use it;
   *  off by default since 2026-10-11 19:05 UTC (its paper run did worse than without it, README "Queue race"). */
  raceOutbid: str("MM_RACE_OUTBID", "off").toLowerCase() === "on",
  /** "on": the level and share exits also run on every update of the live window's Up book (engine.raceOnBook →
   *  orderManager.raceOnly), not only at the decisions on the 10 ms timer: no wait for the timer or the whole quote. That
   *  path only cancels. Tag "+race+rob". Ported from the GSI fork 2026-11-18 (the user's request); there, replay
   *  10-26..11-07: a race cancel 10 ms sooner −$0.02 a window, so expect ~0 from this alone: a latency fix, not an edge. */
  raceOnBook: onOff("MM_RACE_ON_BOOK", "off"),
  /** The level and share rules also while a joining bid's post is still unanswered (orderManager: "race: in flight"), measured
   *  against the level seen when it was posted; a bid posted to an empty level stays exempt, as once live. The cancel goes by
   *  the signed id only with LIVE_EARLY_CANCEL / PAPER_EARLY_CANCEL; without it, it waits for the post's answer as before.
   *  Tag "+rif". Why (2026-11-10, all live runs): the rules only ran once the post was answered, so 20% of race cancels
   *  fired within 10 ms of the answer (post flight p50 ~40–60 ms); a cancel that beats its post keeps the order off the
   *  book. Off by default: a brief dip during the flight now also kills an order that would have rested. */
  raceInflight: onOff("MM_RACE_INFLIGHT", "off"),
  /** Depth cap (2026-11-11, reports/Cancel-in-flight loss methods.md): no new bid joins a level that already holds this many
   *  shares or more at its price (a bid behind a deep queue fills only when a sweep takes the whole level; live in-flight
   *  fills there −2.0¢/sh at 5 s vs −1.1 under 100 sh). "off" (default) = none. Tag "+jmax<N>". */
  joinMaxSh: optNum("MM_JOIN_MAX_SH"),
  /** Adaptive depth cap: no new bid joins a level holding ≥ this × the median best-level size on its side over the last
   *  MM_JOIN_REF_MS (the book's own depth, sampled at each change of the top of the book). Replay (tools/inflight/
   *  adaptive.py): 1.5 cut live 35% / paper 17% of fill shares, 30 s markout +$63 / +$105, no live run negative; fixed 500
   *  +$64 / +$97 with live runs 5 and 7 negative. "off" (default) = none. Tag "+jrel<k×100>". */
  joinRel: optNum("MM_JOIN_MAX_REL"),
  joinRefMs: num("MM_JOIN_REF_MS", 30_000),

  // ---- inventory --------------------------------------------------------------------------------
  /** Shares per side. */
  orderSize: num("MM_ORDER_SIZE", 25),
  /** Cap on |net Up shares| per window. A side that would push past it is cut down, then dropped. */
  maxPosition: num("MM_MAX_POSITION", 100),
  /** "on": the cap also counts every order on a side that can still fill, the ones being cancelled included (a sweep fills
   *  them before the cancel lands), so a new bid is cut to the room left after them. Off: the quoter's cut by the filled
   *  net alone, which a replace chain overshoots (2026-10-20: 17% of paper windows went past 50, up to 72). */
  capPending: str("MM_CAP_PENDING", "off").toLowerCase() === "on",
  /** Centre shift at max position for a 50¢ contract; scales with p(1-p), the payoff variance. */
  skewAtMax: num("MM_SKEW_AT_MAX", 0.02),
  /** v1: in the last N s before the close (quoting itself stops MM_QUOTE_UNTIL_LEFT_SEC before it), only the
   *  side that reduces inventory is quoted. v2 uses MM_V2_REDUCE_ONLY_LEFT_SEC. */
  reduceOnlyLeftSec: num("MM_REDUCE_ONLY_LEFT_SEC", 30),
  /** Market regime refit (regime.ts, 2026-11-14): at each window's open the last `windows` closed windows decide CALM or
   *  BUSY (mean Up spread ≥ busySpr, or BTC 1 s vol ≥ busyVol bp; either "off"), and the window runs on that regime's cap
   *  and order size; unset = MM_MAX_POSITION / MM_ORDER_SIZE. Fewer than minWindows measured = UNKNOWN = those too.
   *  Off by default. Tag "+rg". */
  regime: {
    on: onOff("MM_REGIME", "off"),
    windows: num("MM_REGIME_WINDOWS", 6),
    minWindows: num("MM_REGIME_MIN_WINDOWS", 3),
    busySpr: optNum("MM_REGIME_BUSY_SPR", 0.0116),
    busyVol: optNum("MM_REGIME_BUSY_VOL"),
    calm: { cap: optNum("MM_REGIME_CALM_CAP"), size: optNum("MM_REGIME_CALM_SIZE") },
    busy: { cap: optNum("MM_REGIME_BUSY_CAP"), size: optNum("MM_REGIME_BUSY_SIZE") },
  },
  /** Hour-of-day regimes (hourRegime.ts, 2026-11-17): each window runs on (on) or records (shadow) the config of its
   *  opening UTC hour's regime from `file` (tools/hourregime). "on" replaces MM_REGIME; live needs `live` too. Tag "+hr". */
  hourRegime: {
    mode: oneOf("MM_HOUR_REGIME", ["off", "shadow", "on"] as const, "off"),
    file: str("MM_HOUR_REGIME_FILE", "config/hour-regimes.json"),
    live: onOff("MM_HOUR_REGIME_LIVE", "off"),
    capMax: num("MM_HOUR_REGIME_CAP_MAX", 40),
    sizeMax: num("MM_HOUR_REGIME_SIZE_MAX", 20),
  },

  // ---- tail guard (guard.ts; 2026-10-20, the knobs the tailguard research agent searches) ---------------------------
  /** Rules on top of the v4 quote against big-loss windows; each one is off until its trigger knob is set, except v5's
   *  two (vol cap 0.3, gamma pull 0.6 on the adding side), which are on by default under MM_POLICY=v5 ("off" turns one off). */
  guard: {
    /** Lookback of the mid's total variation (the whipsaw rule and the vol cap), ms. */
    tvMs: num("MM_GUARD_TV_MS", 10_000),
    /** Whipsaw: pull when the good mid's total variation over tvMs (counted in ≥ 1-tick steps) reaches this. */
    whipTv: optNum("MM_WHIP_TV"),
    whipHoldMs: num("MM_WHIP_HOLD_MS", 5000),
    /** both = no bids at all; adding = only the side that adds to |net| (both when flat). */
    whipSide: side("MM_WHIP_SIDE"),
    /** Gamma: pull while φ(Φ⁻¹(centre))·√(300 s / time left) is at least this (0.40 = a 50¢ token at the open). */
    gammaPull: optNum("MM_GAMMA_PULL", V5 ? 0.6 : null),
    gammaSide: side("MM_GAMMA_SIDE", V5 ? "adding" : "both"),
    /** Perp jump: the Binance perp moved this many bps within jumpMs → pull the bid the move runs into for jumpHoldMs. */
    jumpBps: optNum("MM_JUMP_BPS"),
    jumpMs: num("MM_JUMP_MS", 300),
    jumpHoldMs: num("MM_JUMP_HOLD_MS", 1000),
    /** Inventory stop: |net| ≥ this and the held token's mid ≥ invStopLoss under its average cost → no adding for invStopHoldMs. */
    invStopNet: optNum("MM_INV_STOP_NET"),
    invStopLoss: num("MM_INV_STOP_LOSS", 0.05),
    invStopHoldMs: num("MM_INV_STOP_HOLD_MS", 10_000),
    /** Vol cap: once the total variation passes this, the cap shrinks to cap × max(capVolFloor, capVolTv / TV). */
    capVolTv: optNum("MM_CAP_VOL_TV", V5 ? 0.3 : null),
    capVolFloor: num("MM_CAP_VOL_FLOOR", 0.25),
  },

  // ---- pair cost (paircost.ts; 2026-10-22, the knobs the paircost research team searches) ---------------------------
  /** Rules on top of the v4 / v5 quote that use what the window's pairs cost; each one is off until its trigger knob is set. */
  pc: {
    /** Completion cap: while holding, the bid that pairs the held token off is priced so a pair costs at most this. */
    target: optNum("MM_PC_TARGET"),
    /** off = a pairing bid the cap holds back rests at the cap price outside the queue race (its cancel and its gate). */
    race: str("MM_PC_RACE", "on").toLowerCase() !== "off",
    /** Stop: the window's pairs cost this much or more on average → the side that adds to |net| is off for the window. */
    stop: optNum("MM_PC_STOP"),
    /** Widen: the adding side steps back this many ticks per 1¢ the window's pair cost is over widenFrom. */
    widen: optNum("MM_PC_WIDEN"),
    widenFrom: num("MM_PC_WIDEN_FROM", 1.0),
    widenMax: num("MM_PC_WIDEN_MAX", 5),
    /** Pairs merged in the window before stop and widen read its pair cost. */
    minPairs: num("MM_PC_MIN_PAIRS", 20),
    /** Hold: the held token's centre at this or more and the window's pair cost under holdMax → no bid pairs it off. */
    holdP: optNum("MM_PC_HOLD_P"),
    holdMax: num("MM_PC_HOLD_MAX", 1.03),
    /** ... until the favourite falls back to this. */
    holdExit: num("MM_PC_HOLD_EXIT", 0.5),
  },

  // ---- excess (excess.ts; 2026-10-25, the taker knobs the inventory research team searches) --------------------------
  /** Taker completion of the unpaired excess: a fill-and-kill BUY of the short token; each trigger is off until its knob is set. */
  xs: {
    /** Edge: the short token's centre − the limit − the taker fee is at least this. */
    edge: optNum("MM_XS_EDGE"),
    /** Jump: the Binance perp moved this many bps within jumpMs the short token's way. */
    jumpBps: optNum("MM_XS_JUMP_BPS"),
    jumpMs: num("MM_XS_JUMP_MS", 300),
    /** Late: this many s or less to the close. */
    lateSec: optNum("MM_XS_LATE_SEC"),
    /** Stop: the held token's mid this much or more under its average cost. */
    stopLoss: optNum("MM_XS_STOP_LOSS"),
    /** Late and stop keep a held token whose centre is at least this (carry the favourite to settlement). */
    holdP: optNum("MM_XS_HOLD_P"),
    /** |net| needed for any excess take; keep: shares left unpaired; maxSh: shares per take at most. */
    minNet: num("MM_XS_NET", 5),
    keep: num("MM_XS_KEEP", 0),
    maxSh: num("MM_XS_MAX_SH", 20),
    /** The limit = the ask + slip, at most maxPx. */
    slip: num("MM_XS_SLIP", 0),
    maxPx: num("MM_XS_MAX_PX", 0.95),
    cooldownMs: num("MM_XS_COOLDOWN_MS", 2000),
    fromSec: num("MM_XS_FROM_SEC", 5),
    untilLeftSec: num("MM_XS_UNTIL_LEFT_SEC", 10),
    /** on = also on the 10 ms decisions between frames (engine.decide). */
    fast: str("MM_XS_FAST", "on").toLowerCase() !== "off",
  },

  // ---- lock and stop (lock.ts; 2026-11-07 at the user's request) ------------------------------------------------------
  /** Once a fill-and-kill BUY of the short token for the whole |net| locks the window's PnL at pct × the order size in
   *  dollars or more (10 sh × 0.20 = $2) whichever side wins, it is sent and the window stops market making. Tag "+lock<pct%>". */
  lock: {
    /** MM_LOCK_PCT: the PnL to lock, as a share of the order size in dollars (0.20 = 20%); off (default) = no lock rule. */
    pct: optNum("MM_LOCK_PCT"),
    /** The take's limit = the ask + slip, at most maxPx. */
    slip: num("MM_LOCK_SLIP", 0.01),
    maxPx: num("MM_LOCK_MAX_PX", 0.99),
    fromSec: num("MM_LOCK_FROM_SEC", 0),
    untilLeftSec: num("MM_LOCK_UNTIL_LEFT_SEC", 10),
    /** MM_LOCK_PX_F: the price trigger (README "Price lock", 2026-11-11): also lock once the short token's ask ≤
     *  (1 − p)(1 − f), p = the held token's average buy price in the window (f 0.3: 50¢ → 35¢, 30¢ → 49¢), OR-ed with
     *  MM_LOCK_PCT. Off (default) = none. Tag "+lpx<f%>n<min net>". */
    pxF: optNum("MM_LOCK_PX_F"),
    /** ...only while |net| ≥ this many order sizes (2: 20 sh at 10 sh orders). */
    pxMinNet: num("MM_LOCK_PX_MIN_NET", 2),
  },

  // ---- sweep (sweep.ts; 2026-10-25, the knobs the sweep research team searches) ---------------------------------------
  /** Where the side being swept is quoted: a trigger marks a side swept for holdMs, an action re-prices it; nothing
   *  changes unless at least one trigger and one action are set. */
  sw: {
    /** Trigger, jump: the Binance perp moved this many bps within jumpMs (perp down → the Up bid is swept). */
    jumpBps: optNum("MM_SW_JUMP_BPS"),
    jumpMs: num("MM_SW_JUMP_MS", 300),
    /** Trigger, move: the good mid moved this much within moveMs (mid down → the Up bid); moveMs is also back k's window. */
    move: optNum("MM_SW_MOVE"),
    moveMs: num("MM_SW_MOVE_MS", 1000),
    /** Trigger, fill: on = a side that was just filled is swept. */
    fill: onOff("MM_SW_FILL", "off"),
    /** Trigger, whipsaw: the good mid's total variation over tvMs reached this → both sides. */
    tv: optNum("MM_SW_TV"),
    tvMs: num("MM_SW_TV_MS", 10_000),
    /** A side stays swept this long after its last trigger. */
    holdMs: num("MM_SW_HOLD_MS", 2000),
    /** Action, back: a swept side steps back this many ticks, plus backK ticks per 1¢ the mid moved into it over moveMs,
     *  at most backMax. */
    back: num("MM_SW_BACK", 0),
    backK: num("MM_SW_BACK_K", 0),
    backMax: num("MM_SW_BACK_MAX", 5),
    /** Action, centre: cons = a swept side is priced off the more cautious of the quote's centre and the anchored FV. */
    centre: oneOf("MM_SW_CENTRE", ["off", "cons"] as const, "off"),
    /** Action, size: a swept side's size × this (at least the market's minimum). */
    size: num("MM_SW_SIZE", 1),
    /** swept = only the side being swept; both = both sides while either is. */
    side: oneOf("MM_SW_SIDE", ["swept", "both"] as const, "swept"),
    /** on = the re-priced bid is a hard limit (a working bid past it is replaced); off = only new placements take it, a
     *  working bid keeps its queue spot under the order manager's usual tolerance. */
    hard: onOff("MM_SW_HARD", "on"),
  },

  // ---- order management -------------------------------------------------------------------------
  /** paper = quotes become simulated orders against the live book; shadow = quotes only (v0.1); live = REAL orders on
   *  Polymarket from the wallet vault's key + POLYMARKET_FUNDER_ADDRESS (trading/vault.ts, venue.ts). Anything else
   *  stops the bot at boot rather than quietly running paper. */
  mode: mode(str("MM_MODE", "paper")),
  /** MM_TAG: a short name for this setup, e.g. "v6", shown by the dashboard in place of the full window tag
   *  ("v5+queue+race+rif+cap20+…+sweep": its per-setup columns and the window list). Windows are grouped into the
   *  dashboard's setup columns by this name, so bump it when the settings change ("version up"); the full tag is
   *  still recorded in every window's index entry and archive. Empty (default) = the full tag, as before 2026-11-10. */
  tagName: str("MM_TAG", "").trim(),
  /** live: no new orders, and every working one cancelled, once the account's PnL (equity − its start) is this far
   *  down. It stays stopped across restarts until the limit is raised or the dashboard's reset PnL (which lifts it at once). */
  liveMaxLoss: num("LIVE_MAX_LOSS", 60),
  /** LIVE_LOSS_ON: what the loss limit counts. mark (default, the rule before 2026-11-07) = equity − start, the open window
   *  marked at the mid, so a move against open inventory can trip it mid-window; settled = only windows that have their
   *  label (run 5 stopped at −$20.05 on a mark inside a window that settled +$2.93; settled it never passed −$15.82). */
  liveLossOn: oneOf("LIVE_LOSS_ON", ["mark", "settled"] as const, "mark"),
  /** live: each order is signed once and that one body posted this many times at once (1-10), on as many warm
   *  connections; the venue places it once, from the copy that clears its queue first, and refuses the rest as
   *  "Duplicated" (venue.ts racePosts). The latency probes (2026-10-15), placement after the send on BTC-move bursts, the
   *  fastest of k: 1 copy median 81 / p90 737 ms, 23% over 300 ms; 2: 62 / 579, 18%; 3: 54 / 460, 15%; 4: 48 / 432, 14%
   *  (v1, 13 bursts: 6 copies 131 / 226 ms, 8% over 300, against 281 / 650, 49% for one). The pair live app sends 5 since
   *  2026-10-15, at the user's request. */
  livePostCopies: Math.max(1, Math.min(10, Math.round(num("LIVE_POST_COPIES", 1)))),
  /** live: a cancel decided while the order's post is still unanswered goes out at once, by the venue id computed from
   *  the signed order (its hash), instead of waiting for the answer to bring the id (liveExchange.ts "Early"). Real 1¢
   *  orders (2026-10-29): the id matched 16 of 16; a cancel that beats its post gets the post refused "Already canceled".
   *  Live 10-23 (off): 20% of orders were cancelled before their answer, waiting a median 33 ms (p90 154) for the id. */
  liveEarlyCancel: onOff("LIVE_EARLY_CANCEL", "off"),
  /** live: each cancel sent this many times at once (1-4) on as many warm connections; it counts as done at the first
   *  copy that cancelled (venue.ts raceCancels). A cancel can't fill anything, so copies are safe; the extra copies
   *  answer "not found". Real 1¢ orders (2026-10-29 cancel2, 40 calm cancels): two copies first answer p50 29.8 / p90
   *  51.6 ms against 33.5 / 59.2 for one. Tag "+cc<N>". Ported from the GSI fork 2026-11-18. */
  liveCancelCopies: Math.max(1, Math.min(4, Math.round(num("LIVE_CANCEL_COPIES", 1)))),
  /** live: "own" = a cancel goes out on the bot's own request (venue.ts ownCanceller: the SDK's exact DELETE /order with
   *  its L2 headers, signed with a synchronous node:crypto HMAC, on the global fetch) instead of the SDK's cancelOrder
   *  (WebCrypto key import + sign on the threadpool, ky, zod). Anything but an HTTP 200 answer, or no answer, falls back
   *  to the SDK in the same call; a 401/403 turns it off for the run. Early cancels (LIVE_EARLY_CANCEL) take the same
   *  path. Expected < 1–2 ms a cancel (README "Own HTTP cancel" 11-11). Tag "+own". Ported from the GSI fork 2026-11-18. */
  liveCancelHttp: (str("LIVE_CANCEL_HTTP", "sdk").toLowerCase() === "own" ? "own" : "sdk") as "own" | "sdk",
  /** live: the bot's own gasless merge / redeem jobs (trader.ts "chain"; they also need the Relayer key). Off by default
   *  since 2026-11-13 at the user's request: every one has failed since ~11-12 (@polymarket/client 0.6.0 checks Gamma's
   *  market against a schema that wants marketMakerAddress, which Gamma no longer sends: "Received an incompatible API
   *  response"), while Polymarket redeems each settled position itself, 60–388 s after the close (all 192 on the
   *  wallet 11-09 → 11-13). The queued jobs blocked the dashboard's wallet sync. */
  liveChain: onOff("LIVE_CHAIN", "off"),
  /** live: the other bots on the same wallet, as their live state.json paths (comma-separated; trading/peers.ts): the
   *  wallet check counts their booked tokens too. Since 2026-11-17 (btc5m-ask-live shares this wallet). */
  livePeerState: peerFiles(str("LIVE_PEER_STATE", "")),
  /** MM_CANCEL_DELAY_MS (default 0 = off; challenger 2026-11-06 at the user's request): every cancel of a resting order is
   *  sent this long after the bot decides it, paper and live. The order manager counts the order as cancelling at once;
   *  the venue keeps it this much longer, so a taker in that time still fills it (the 150 ms taker hold, made real).
   *  Tag "+cd<N>". */
  cancelDelayMs: Math.max(0, Math.round(num("MM_CANCEL_DELAY_MS", 0))),
  /** live: more orders than this placed in 10 s pauses placing for 10 s: a runaway-loop guard. Paper v4 +10ms
   *  (43 windows, 2026-10-13 06:00–09:30 UTC): 855 orders a window (median), 10 s peak median 67, max 126. */
  liveMaxPlaces10s: num("LIVE_MAX_PLACES_10S", 200),
  /** A working order that is only LESS aggressive than the target is kept at least this long, for its queue spot. */
  requoteMinMs: num("MM_REQUOTE_MIN_MS", 1000),
  /** A working order up to this many ticks MORE aggressive than the target keeps its queue spot while it is still
   *  MM_TOLERATE_EDGE inside the reservation (0 = replace at once). */
  tolerateTicks: num("MM_TOLERATE_TICKS", 1),
  tolerateEdge: num("MM_TOLERATE_EDGE", 0.0025),
  /** A working order at the best price of its book is not moved up to a more aggressive target ("off" = chase it). */
  stayAtTouch: str("MM_STAY_AT_TOUCH", "on").toLowerCase() !== "off",
  paperStartUsdc: num("PAPER_START_USDC", 1000),
  /** One-way place/cancel latency. A cancel in flight can still be filled. Measured 2026-10-13 from this server (AWS
   *  eu-west-1) with 30 real orders, send → visible on the public feed: place 36 ms, cancel 29 ms median
   *  (tools/latency-test.ts). 65 on the Helsinki VPS before it (place 68, cancel 56), an unmeasured 150 before that. */
  paperLatencyMs: num("PAPER_LATENCY_MS", 35),
  /** Between the 100 ms frames the paper exchange also matches every this many ms: fills only, while quotes, takes and the
   *  order manager stay on the frame. 0 = match at frames only. Why (2026-10-12, 1,144 windows replayed with the bot's own
   *  code): at a 65 ms latency every cancel lands before the next frame, so matching only at frames dropped the fills
   *  that hit while a cancel was in flight and brief run-throughs of our price. That showed −$5.4 a window; matching
   *  every 20 / 10 ms gave −$9.4 / −$9.6, so 10 ms is converged. */
  paperStepMs: num("PAPER_STEP_MS", 10),
  /** v4 windows: between the frames, re-run the quote and the order manager every this many ms (at most as often as
   *  PAPER_STEP_MS, right after its fills), with the flow FV re-scored on the latest book, tape and Binance. Takes stay
   *  on the frame. 0 = decisions at frames only. Tag "+10ms". Why (2026-10-13, 2,013 windows of 10-05..10-11 replayed
   *  with the bot's own code): Polymarket holds every taker order 150 ms but not our cancels, and a 100 ms frame
   *  spent most of that head start waiting. Deciding every 10 ms gained +$2.72 a window (7/7 days), maker fills
   *  −0.78 → +0.27¢ a share; with flow takes off as well, +$3.87 (−$0.09 a window, 13 fills). README "10 ms decisions". */
  decideStepMs: num("MM_DECIDE_STEP_MS", 0),
  /** With MM_DECIDE_STEP_MS > 0, also run the decide step (quote, takes, order manager; no paper matching, no /signal
   *  sample) as soon as an input changes, not only on the 10 ms timer: "book" = an Up book change of the window,
   *  "all" = that or a Binance spot / perp mid change. The timer keeps its cadence beside it (the paper exchange's
   *  matching, the fills and the /signal detectors stay on it). Tag "+evbook" / "+evall". Why (2026-11-10): the timer
   *  leaves ~5 ms on average (10 ms max) between a book change and the race or replace cancel it calls for. Off by
   *  default: worth at most ~1–2% of the live in-flight fills by the measured slope (README "Event decisions"). */
  decideEvents: oneOf("MM_DECIDE_EVENTS", ["off", "book", "all"] as const, "off"),
  /** Event decisions run at most this often (ms); one inside the gap waits for its end. */
  decideEventMinMs: num("MM_DECIDE_EVENT_MIN_MS", 2),
  /** The decide step's model FV (the flow FV's lead / anchored-lead / z / delta features, the fallback centre, the anchored
   *  lead): "frame" = the last 100 ms frame's (up to 100 ms old), "fresh" = recomputed at the step on the latest Binance /
   *  Coinbase / Chainlink mids with the frame's sigma (pricers.ts). The book, tape and spot / perp returns are fresh either
   *  way. Tag "+fresh". Off by default (2026-11-10): a Binance spot move gave no lead before the live in-flight fills. */
  decideFv: oneOf("MM_DECIDE_FV", ["frame", "fresh"] as const, "frame"),
  /** Maker rebate the paper account credits on every maker fill: this share of the taker fee 0.07·p(1−p) on the same
   *  shares (Polymarket pays 20% of the taker fees to makers, daily, pro rata by that fee-equivalent). 0 = none. */
  paperMakerRebate: num("PAPER_MAKER_REBATE", 0.2),
  /** Polymarket's taker delay on crypto markets, added to a taker order's latency (2026-09-04: 150 ms). */
  paperTakerDelayMs: num("PAPER_TAKER_DELAY_MS", 150),
  /** A paper take's send → its match at the venue, the taker delay included (default PAPER_LATENCY_MS +
   *  PAPER_TAKER_DELAY_MS, 185 ms). Live takes take longer: pair leg 1 answered a median 291 ms after the signal on 10-15
   *  (p75 351, p90 531), queueing at the venue first. On the 81 signals the paper and live pair apps both traded
   *  (10:54-12:38 UTC), live filled leg 1 46% at −4.0¢ a pair; a frame replay of paper's pairs gave 185 ms 65% −0.1¢,
   *  300 ms 51% −1.6¢, 400 ms 48% −2.3¢. The paper pair app runs 300 since 2026-10-15 at the user's request. */
  paperTakeMs: num("PAPER_TAKE_MS", num("PAPER_LATENCY_MS", 35) + num("PAPER_TAKER_DELAY_MS", 150)),
  /** PAPER_TAKE_MS=live: each paper take's send → match is drawn from the live market maker's own take answers
   *  (venueLatency.ts LIVE_TAKE_MS, median 348 ms, never under 185) instead of the constant above (2026-11-05). */
  paperTakeLive: str("PAPER_TAKE_MS", "").trim().toLowerCase() === "live",
  /** How the paper exchange fills maker orders (README "Fill model calibration").
   *  sweep  (default since 2026-10-13) calibrated on the live bot's first 2,644 real orders: fills come only from prints;
   *         each print's sweep is rebuilt on the book PAPER_SWEEP_BOOKLAG_MS before it and pinned to its VWAP; an order is
   *         in it if it reached the venue (sent + PAPER_SWEEP_PLACE_MS) before the taker arrived (print − the taker
   *         delay) and its cancel (sent + PAPER_SWEEP_CANCEL_MS) did not; liquidity the taker did not find at our price
   *         had escaped ahead of us. On those orders (this exchange's own replay, tools/fillcal/replay.ts MODEL=sweep):
   *         1,384 shares vs 1,018 real (queue model 407); 1 s / 5 s markout −3.6 / −4.0¢ vs real −3.0 / −2.1¢ (queue
   *         −1.8 / +1.9¢); settled −1.3¢ a share vs real −10.2¢ (queue +6.4¢). Still kinder than reality at 30 s and at
   *         the label, so treat paper PnL as an upper bound. Paper windows on it are tagged "+sweep".
   *  queue  the model before: queue position from prints at our price, through-prints, and book crosses. */
  paperFillModel: (str("PAPER_FILL_MODEL", "sweep") === "queue" ? "queue" : "sweep") as "queue" | "sweep",
  paperSweep: {
    /** Send → at the venue: 28 ms median from eu-west-1 (tools/latency-test.ts, 2026-10-13). The calibration's orders were
     *  sent from Helsinki, where it was 50. */
    placeMs: num("PAPER_SWEEP_PLACE_MS", 28),
    /** The conservative end. In Helsinki 40 matched the real share count, but its fills settled +5.3¢ a share on orders
     *  that really lost 10.2¢; 70 filled a third more and settled −1.3¢ (2026-10-13, 3 windows: noisy). A cancel took
     *  38 ms to the venue there and 21 here, so 55 = 21 + the same 32 ms margin. Replay Helsinki orders with 70. */
    cancelMs: num("PAPER_SWEEP_CANCEL_MS", 55),
    bookLagMs: num("PAPER_SWEEP_BOOKLAG_MS", 35),
    /** Local receive − exchange time of the feed: when the venue's moment shows here. 12–14 ms inside the running bot on
     *  eu-west-1 (2026-10-13); 37 in Helsinki (the L2 recorder's prints, 2026-10-13 median). */
    feedLagMs: num("PAPER_SWEEP_FEEDLAG_MS", 13),
    /** PAPER_SWEEP_LAT: each order's place and cancel times drawn from live orders' (venueLatency.ts, README "Venue latency
     *  from live orders" and "Paper vs live, 5 windows"), in place of PAPER_SWEEP_PLACE_MS / PAPER_SWEEP_CANCEL_MS. Tag "+lat"
     *  ("+latbusy").
     *    live   (default since 2026-10-23) the live market maker's own times of 2026-10-23 (3,034 orders): calm (place
     *           median 29 ms, p90 88; cancel 26, p90 82), or swept for the orders sent or cancelled within 150 ms of a taker
     *           whose sweep reached our price (83 / 70, p90 149 / 137: measured on orders that did NOT fill, so it is the
     *           venue slow around a sweep, not slow cancels filling), and for PAPER_SWEEP_LAT_SWEPT_MS after such a taker
     *           arrived or PAPER_SWEEP_LAT_BUSY_MS after the target quote moves PAPER_SWEEP_LAT_MOVE within
     *           PAPER_SWEEP_LAT_LOOKBACK_MS. No price move predicted the slow venue in that run; the sweeps did.
     *    fixed  the constants (the default 10-13 → 10-23).
     *    busy   the swept tables on every order: the pessimistic bound.
     *  The fill count under it is unverified: the box has no L2 tape of those windows to replay the live orders on. The
     *  tables before 2026-10-23 were the live pair app's bids of 10-14/15, each sent on a ≥ 6¢ move (place median 113,
     *  p90 794; cancel 61, p90 390), calm = those × PAPER_SWEEP_LAT_CALM (now only for flat test tables). */
    lat: ((): LatCfg | null => {
      const mode = str("PAPER_SWEEP_LAT", "live").toLowerCase();
      if (mode !== "live" && mode !== "busy") return null;
      return {
        mode, calm: num("PAPER_SWEEP_LAT_CALM", 0.35), move: num("PAPER_SWEEP_LAT_MOVE", 0.06), lookbackMs: num("PAPER_SWEEP_LAT_LOOKBACK_MS", 200),
        busyMs: num("PAPER_SWEEP_LAT_BUSY_MS", 1000),
        /** A sweep that reached our price keeps the venue busy this long after the taker arrived: live, orders 150–500 ms
         *  from one ran 46 / 50 ms, 500–1000 ms 34 / 31, against 29 / 26 calm. */
        sweptMs: num("PAPER_SWEEP_LAT_SWEPT_MS", 500),
        /** The venue's state decays over this (venueLatency.ts): consecutive sends 0–100 ms apart correlated 0.80 live,
         *  100–1000 ms 0.55, 1–5 s 0.28. */
        tauMs: num("PAPER_SWEEP_LAT_TAU_MS", 2000),
        /** The draws repeat with the seed (replays). */
        seed: num("PAPER_SWEEP_LAT_SEED", 1),
        /** PAPER_SWEPT_CANCEL=1023: the swept cancel table of 2026-10-23 (median 70 ms) in place of the live race-twin table
         *  of 2026-11-03 (median 32; README "Paper cancel model from live"), for replays of the older paper record. */
        ...(str("PAPER_SWEPT_CANCEL", "1103") === "1023" ? { cancel: SWEPT_CANCEL_MS_1023, cancelCalm: CALM_CANCEL_MS, sweptCancel: "1023" as const } : {}),
        /** PAPER_NEWBEST_LAT. A post that sets a new best price at its send (on the latest book view) reaches the venue after a
         *  time drawn from a new-best table (venueLatency.ts), busy or calm. Its post-only check and the early cancel's race
         *  run at that arrival.
         *    copies3  default since 2026-11-09 ~21:40 UTC. Live with LIVE_POST_COPIES=3: median 97, p90 332. Tag "+nb3".
         *    twin288  the first table, 2026-11-09 morning: median 288, p90 1,128. It was measured on a narrower class than it
         *             is applied to, so it is too strict. Tag "+nb".
         *    off      the calm / swept tables, as for any other post (median ~30 / ~80; the rule before). */
        ...((): Pick<LatCfg, "newBest" | "newBestName"> => {
          const nb = str("PAPER_NEWBEST_LAT", "copies3").toLowerCase();
          return nb === "off" ? { newBest: null } : nb === "twin288" || nb === "twin" ? { newBest: TWIN_NEWBEST_PLACE_MS, newBestName: "twin288" }
            : { newBest: COPIES3_NEWBEST_PLACE_MS, newBestName: "copies3" };
        })(),
      };
    })(),
    /** The venue's post-only check sees our own resting orders (2026-10-23: 17 of the live bot's 113 refusals in 5 windows
     *  had our own bid on the other token across the price within 300 ms; the paper exchange had accepted every one).
     *  off = before. */
    selfCross: str("PAPER_SELF_CROSS", "on").toLowerCase() !== "off",
    /** A fill reaches the trader this long after the venue's match: the user channel's delay live (heard − venue clock:
     *  median 80 ms, p90 84, p99 86 on 52 live fills of 2026-10-23). 0 = as it prints (before 2026-10-23). */
    heardMs: num("PAPER_FILL_HEARD_MS", 80),
    /** When a cancelling order leaves the pending-order cap (MM_CAP_PENDING): ack = at the venue's cancel answer (its landing
     *  + 10 ms; live the cancel's answer took a median 37 ms, p90 106), as the live bot; tail = once no print can reach it
     *  any more (the cancel + the taker delay + 150 ms, about 355 ms; before 2026-10-23, so the paper cap held new bids
     *  back ten times longer than live's). */
    pendingUntil: (str("PAPER_PENDING_UNTIL", "ack").toLowerCase() === "tail" ? "tail" : "ack") as "ack" | "tail",
    /** LIVE_EARLY_CANCEL on paper (defaults to it, so a paper app beside the live one models the same bot): with drawn venue
     *  times a cancel no longer waits for the post's answer, and one that reaches the venue before its order is placed
     *  means the order never rests (the venue refuses the post "Already canceled"). Tag "+ec". */
    earlyCancel: onOff("PAPER_EARLY_CANCEL", onOff("LIVE_EARLY_CANCEL", "off") ? "on" : "off"),
    /** PAPER_TAKER_HOLD (paperExchange.ts header, "Hold"): on (default, the rule before 2026-11-06) = a cancel landing during
     *  the taker's PAPER_TAKER_DELAY_MS is too late; off = it escapes unless it landed after the print's match time. Tag "+nh". */
    hold: onOff("PAPER_TAKER_HOLD", "on"),
  },

  // ---- book hygiene ----------------------------------------------------------------------------
  /** A mid is "good" (usable for calibration and scoring) only when the spread is at most this. */
  maxGoodSpread: num("MAX_GOOD_SPREAD", 0.03),
  /** ...and the book updated within this many ms. */
  maxBookAgeMs: num("MAX_BOOK_AGE_MS", 3000),

  // ---- move signal for other bots: WS /signal (signal.ts; 2026-10-14 study, README "Move signal") ----------------------
  signal: {
    /** Smallest target-quote move that fires a signal (Up price units, the mean over the target sides present both
     *  times). With leadOnly, on 139 archived windows: 3¢ in 100 ms, 21 a window, the Up mid then moved the same way within
     *  500 ms 82% of the time (4% the other way), +4.2¢; 4¢: 12 a window, 87% / 3%, +5.6¢; 5¢: 7, 88% / 2%, +6.7¢.
     *  "off" = no signals; /signal then only heartbeats. */
    minMove: numOff("SIGNAL_MIN_MOVE", 0.03),
    /** Only moves the book has not made yet (its mid unchanged over the lookback) and the flow forecast points to (its
     *  predicted 2 s move on the same side). Without it the 10 ms detector's signals hit 77% / 12% at 500 ms, with it
     *  86% / 2% (8 live windows, 2026-10-14). "off" = every move. */
    leadOnly: str("SIGNAL_LEAD_ONLY", "on").toLowerCase() !== "off",
    /** ...and only when the flow forecast (its predicted 2 s mid move, Up price units) points the move's way by at least
     *  this: the floor under `top`. On the 579 signals the feed sent in 18 live windows (2026-10-14 09:55-11:25) it kept
     *  34%: the Up mid moved the same way within 500 ms 91% of the time and the other way 1%, against 82% / 5%, +5.6¢
     *  against +3.6¢. The 10 ms trace and 160 archived windows agree. But forecasts grow with volatility: from 11:30, a
     *  busy hour, it kept 51-82% (38 a window). "off" = no floor. */
    minPred: numOff("SIGNAL_MIN_PRED", 0.035),
    /** ...and only the strongest this share of the moves by that forecast, among the last 100 the detector found (each
     *  judged once, at its first step), so about this share of them goes out whatever the hour. Frame detector on the
     *  windows from 09:55: quiet hours 19 → 6.8 a window (36%), 93% / 0% at 500 ms (all moves 85% / 3%); the busy hour
     *  33 → 10.2 (31%), 93% / 0%, at 1 s 98% / 0% (all 81% / 11%). The 10 ms replay of the morning trace: 36.9 → 12.5
     *  (34%), 89% / 0%. "off" = the floor alone. */
    top: numOff("SIGNAL_TOP", 1 / 3),
    /** The move is measured against the target this long ago. */
    lookbackMs: num("SIGNAL_LOOKBACK_MS", 100),
    /** After a signal, no other one in the same direction for this long (one move fires once). */
    cooldownMs: num("SIGNAL_COOLDOWN_MS", 1000),
    /** A heartbeat to every subscriber this often, so a quiet feed is told apart from a dead one. */
    heartbeatMs: num("SIGNAL_HEARTBEAT_MS", 1000),
  },

  // ---- fill signal: WS /signal-fills (signal.ts "FILL SIGNAL"; 2026-11-11) ---------------------------------------------
  /** FILL_SIGNAL: which of this bot's maker fills go out, comma-separated: nocancel (resting, no cancel sent), race (a
   *  race cancel was in flight). "off" = none; the feed then only heartbeats. Default: live nocancel, paper nocancel,race. */
  fillSignal: ((): { nocancel: boolean; race: boolean } => {
    const v = str("FILL_SIGNAL", mode(str("MM_MODE", "paper")) === "live" ? "nocancel" : "nocancel,race").toLowerCase().split(",").map((x) => x.trim());
    for (const x of v) if (x && !["nocancel", "race", "off"].includes(x)) throw new Error(`FILL_SIGNAL: unknown kind "${x}" (nocancel, race, off)`);
    return v.includes("off") ? { nocancel: false, race: false } : { nocancel: v.includes("nocancel"), race: v.includes("race") };
  })(),

  // ---- follow trade (follow.ts; 2026-11-11 at the user's request: the paper challenger) ------------------------------
  /** FOLLOW_TRADE=on: no market making; each fill another bot sends on WS /signal-fills (of a FOLLOW_KINDS kind) is followed
   *  by a fill-and-kill buy of the same token, held to settlement (tag "follow"). Paper / shadow only. */
  follow: (() => {
    const on = str("FOLLOW_TRADE", "off").toLowerCase() === "on";
    if (on && mode(str("MM_MODE", "paper")) === "live") throw new Error("FOLLOW_TRADE=on is paper only (MM_MODE=live)");
    const k = str("FOLLOW_KINDS", "nocancel,race").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
    for (const x of k) if (!["nocancel", "race"].includes(x)) throw new Error(`FOLLOW_KINDS: unknown kind "${x}" (nocancel, race)`);
    return {
      on,
      /** The source bot's fill feed (eth5m-mm-bot, the paper market maker). */
      url: str("FOLLOW_URL", "ws://127.0.0.1:8040/signal-fills"),
      kinds: { nocancel: k.includes("nocancel"), race: k.includes("race") },
      /** Shares a take: 0 = the source fill's, else this; at most maxSh. maxWinSh: shares a window at most (off = none). */
      size: num("FOLLOW_SIZE", 0),
      maxSh: num("FOLLOW_MAX_SH", 20),
      maxWinSh: optNum("FOLLOW_MAX_WIN_SH"),
      /** The limit = the token's ask + slip (its own knob: .env's MM_XS_SLIP is the jump take's), at most maxPx. */
      slip: num("FOLLOW_SLIP", 0.02),
      maxPx: num("FOLLOW_MAX_PX", 0.95),
      /** A signal heard later than this after it was sent is dropped (the source's restart, a reconnect). */
      maxAgeMs: num("FOLLOW_MAX_AGE_MS", 1000),
      fromSec: num("FOLLOW_FROM_SEC", 0),
      untilLeftSec: num("FOLLOW_UNTIL_LEFT_SEC", 10),
    };
  })(),

  // ---- fast move signal: WS /signal-fast, a second detector beside /signal (signal.ts; 2026-10-15) --------------------
  // The pair's own detector (lead-only, no forecast threshold) with a 100 ms lookback in place of its 200 ms, so a move fires
  // when it is sharp, early in it: the venue's queue grows within a few hundred ms of a BTC move (README "Latency probe").
  // The pair trade uses it with PAIR_SIGNAL=fast. Same messages as /signal, each with "signal": "fast".
  fastSignal: {
    /** On the paper pair app's 100 ms frames of 10-15 (19.3 h, to 240 s into the window): 5¢ in 100 ms fired 76 an hour,
     *  the Up mid then moved the same way within 500 ms 81% of the time (4% the other way), +5.2¢; 4¢ 142 an hour, 80% /
     *  4%; 6¢ 46 an hour, 81% / 4%, +6.0¢. The pair's 6¢ in 200 ms: 74 an hour, 82% / 3%, +5.5¢. 5¢ in 100 ms caught 70%
     *  of those, a frame earlier on 13%. "off" = no signals. */
    minMove: numOff("FAST_SIGNAL_MIN_MOVE", 0.05),
    leadOnly: str("FAST_SIGNAL_LEAD_ONLY", "on").toLowerCase() !== "off",
    /** Off by default, as in the pair's detector (a number: a floor, as SIGNAL_MIN_PRED). */
    minPred: str("FAST_SIGNAL_MIN_PRED", "off").toLowerCase() === "off" ? null : num("FAST_SIGNAL_MIN_PRED", 0.035),
    /** Off by default (a share: as SIGNAL_TOP). */
    top: str("FAST_SIGNAL_TOP", "off").toLowerCase() === "off" ? null : num("FAST_SIGNAL_TOP", 1 / 3),
    lookbackMs: num("FAST_SIGNAL_LOOKBACK_MS", 100),
    cooldownMs: num("FAST_SIGNAL_COOLDOWN_MS", 1000),
    heartbeatMs: num("SIGNAL_HEARTBEAT_MS", 1000),
  },

  // ---- pair trade (pairTrader.ts; 2026-10-14 study, README "Pair trade") -----------------------------------------------
  pair: {
    /** on = no market making: the windows trade the move signal in Up+Down pairs (tag "pair"). */
    on: str("PAIR_TRADE", "off").toLowerCase() === "on",
    /** Leg 1 needs a target move at least this big in PAIR_LOOKBACK_MS (leading the book as PAIR_LEAD says, and the flow
     *  forecast on its side). With a maker leg 1 and a 200 ms lookback, on 3.2 h of recorded book (2026-10-14 17:20-20:30, fills 200 ms
     *  past the cancel): 4¢ −0.8¢ a pair, 5¢ +2.3¢ (6.0 pairs an hour), 6¢ +4.7¢ (3.5 an hour, the most per hour, both
     *  halves positive), 7¢ +4.8¢ (2.5), 8¢ +3.5¢. (Taker leg 1, 100 ms, 144 archived windows: 5¢ +4.6¢ on paper.) */
    minMove: num("PAIR_MIN_MOVE", 0.06),
    /** The pair detector's lookback (the /signal feed keeps SIGNAL_LOOKBACK_MS). */
    lookbackMs: num("PAIR_LOOKBACK_MS", 200),
    /** own: the pair's own detector (PAIR_MIN_MOVE in PAIR_LOOKBACK_MS). fast: the /signal-fast feed's (FAST_SIGNAL_*,
     *  5¢ in 100 ms), in btc5m-pair-live from 2026-10-15 to 2026-10-16 09:00 UTC; no app uses it now. */
    signal: (str("PAIR_SIGNAL", "own").toLowerCase() === "fast" ? "fast" : "own") as "own" | "fast",
    /** What counts as the target leading the book. unmoved: the book mid did not move over the lookback. excess: the mid
     *  was still or moved the target's way, and the target moved at least PAIR_MIN_MOVE more than it (a mid that moved
     *  the other way still blocks). At 6¢ in 200 ms, healthy feed (2026-10-16, README "Lead rule"): excess adds ~20% more
     *  signals (3 weeks 14.6 → 17.7 a window; the bot's records 17.4 → 20.7); the added ones lead as often (90% vs 87% of
     *  the Up mid moving their way within 0.5 s) and pair about as well at the same gap widening (taker leg 1, ask + 1¢:
     *  −1.00¢ vs −0.32¢ a pair on 3 weeks, −0.17¢ vs −0.09¢ on the records). Book moves the other way: 57% / 19%, −2.8¢. */
    lead: (str("PAIR_LEAD", "unmoved").toLowerCase() === "excess" ? "excess" : "unmoved") as "unmoved" | "excess",
    /** How the target's move is measured (signal.ts). both: the average of its bid's and ask's moves. free: only the sides
     *  the post-only rule did not hold a tick off the book, so a one-sided jump counts in full (both averaged it with the
     *  held side's 0, halving it). Replay of the bots' 100 ms records (723 windows, 10-13 22:00 → 10-16 10:05 UTC; 200 ms,
     *  excess, taker leg 1 at ask + 5¢ matched 300 ms on, leg 2 2 s later, both fees; README "Free-side move"): free 15¢
     *  +4.0¢ a pair, +$2.6 an hour at 5 sh; 18¢ +6.2¢, +$2.2; both 12¢ +9.1¢, +$1.6. Matched 500 ms on, 18¢ is the best
     *  (+3.5¢, +$0.7). Live never filled a leg 1 on a move this big (0 of 47 at 8¢+ averaged), which the replay can't see. */
    move: (str("PAIR_MOVE", "both").toLowerCase() === "free" ? "free" : "both") as "both" | "free",
    /** maker: leg 1 is a post-only bid on the rising token at its best bid, cancelled after PAIR_MAKER_MS, no taker
     *  fallback. taker: a fill-and-kill buy up to PAIR_SLIP over its ask. Live takers filled 11% of the signals and lost
     *  2.3¢ a pair (2026-10-14 16:15-18:25, 229 signals): the 150 ms taker hold, and faster takers, empty the ask first.
     *  On the recorded book a maker bid filled 6-10% and made +2 to +5¢ a pair (README "Pair trade · maker leg 1"). */
    leg1: (str("PAIR_LEG1", "maker").toLowerCase() === "taker" ? "taker" : "maker") as "maker" | "taker",
    /** A maker leg 1 is cancelled this long after it was sent: fills in the first 0.5 s came before the move (the falling
     *  token −6¢ two seconds on); later ones as it turned, and erased the gain (1 s +1.6¢, 2 s +0.8¢ a pair). */
    makerMs: num("PAIR_MAKER_MS", 500),
    /** A maker leg 1 is not sent when more than this many shares already rest at its bid; off (the default since
     *  2026-10-14 21:25 UTC, the user's choice) = always sent. At the back of the queue it seldom fills in its life. On the
     *  recorded book (6¢/200 ms, 0.5 s, 17:20-20:55): under 50 ahead 35% filled, 50-300 12%, 300-1,000 3%, over 1,000
     *  0.7%; 80% of the bids had over 300 ahead. */
    maxQueue: str("PAIR_MAX_QUEUE", "off").toLowerCase() === "off" ? null : num("PAIR_MAX_QUEUE", 300),
    /** Taker leg 1 is a fill-and-kill buy at most this far over the token's ask at the signal. A taker waits 150 ms at the
     *  venue while the makers re-price: +1¢ filled 32% of the 5¢ signals at +4.6¢ a pair, +2¢ 40% at +3.5¢, +10¢ 95%
     *  at +0.7¢. */
    slip: num("PAIR_SLIP", 0.01),
    /** Leg 2 (the other token, as a taker) goes this long after leg 1 filled: 1 s +2.7¢, 2 s +3.5¢, 5 s +3.6¢ a pair
     *  (5¢ signals, +2¢); a maker take-profit or a stop-loss did no better (2026-10-14). With PAIR_CLOSE_EDGE set, this is
     *  the longest leg 2 waits. */
    holdMs: num("PAIR_HOLD_MS", 2000),
    /** Leg 2 goes before PAIR_HOLD_MS is up once the pair would lock at least this much a pair at the other token's best
     *  ask, after both fees: 1 − (leg 1's price + its fee a share) − (that ask + its fee). off (default) = always at
     *  PAIR_HOLD_MS. Leg 2 still goes out at up to PAIR_CLOSE_SLIP over the ask, so a fill a few ticks up locks less, and
     *  once it has gone it buys until done (it does not go back to waiting). */
    closeEdge: str("PAIR_CLOSE_EDGE", "off").toLowerCase() === "off" ? null : num("PAIR_CLOSE_EDGE", 0.1),
    /** Leg 2 goes before PAIR_HOLD_MS is up if, within PAIR_STOP_MS of leg 1's fill, the Up mid has moved at least this far
     *  against leg 1 from where it was at the fill (down for an Up leg 1, up for a Down one). off (default) = no stop.
     *  On top of PAIR_CLOSE_EDGE 10¢ / PAIR_HOLD_MS 10 s (2026-10-16, README "Edge close"; leg 2 at the feed's other ask
     *  0.26 s after it is sent): live's own 70 leg-1 fills −6.22¢ a pair without, 1¢ in 3 s −4.10¢ (+2.1 ± 0.8 paired),
     *  about a plain 2 s hold's −4.55¢; on the replay ±0.4¢, within noise. */
    stopMove: str("PAIR_STOP_MOVE", "off").toLowerCase() === "off" ? null : num("PAIR_STOP_MOVE", 0.01),
    /** How long after leg 1's fill PAIR_STOP_MOVE watches. */
    stopMs: num("PAIR_STOP_MS", 3000),
    /** The leg-2 model (README "Leg-2 model"; model/legTwo.ts): at leg 1's fill, P(the Up mid moves against leg 1 over the
     *  next 5 s), from the window's 100 ms rows. off (default) = not loaded. on = leg 2 goes at once when P ≥
     *  PAIR_L2_MODEL_P, before the edge / stop / hold. ab = the same in even 5-minute slots only (startTs / 300 even), so the
     *  odd ones are the control; every pair records P either way. Replay, held-out days (2026-10-18): AUC 0.74; at P ≥ 0.50 it
     *  fires on 23% of the pairs and gains +0.38¢ on those over today's rules (edge 6¢, stop 1¢/3 s, hold 5 s), +0.09¢ a pair. */
    l2Model: (["on", "ab"].includes(str("PAIR_L2_MODEL", "off").toLowerCase()) ? str("PAIR_L2_MODEL", "off").toLowerCase() : "off") as "off" | "on" | "ab",
    /** The probability at or over which the leg-2 model sends leg 2 at once. */
    l2ModelP: num("PAIR_L2_MODEL_P", 0.5),
    /** The leg-2 model file (tools/l2model). */
    l2ModelFile: path.resolve(ROOT, str("PAIR_L2_MODEL_FILE", "models/l2-h5.json")),
    /** Shares a leg. A median 173 rested at the best ask (10th percentile 31), 697 within 1¢ (2026-10-14, 3 min). */
    size: num("PAIR_SIZE", 10),
    /** No new pair this many seconds into the window or later (240-285 s lost: the settlement average is running). */
    untilSec: num("PAIR_UNTIL_SEC", 240),
    /** No leg 1 on a token asking more than this (leg 1 at 75¢ or more made nothing). */
    maxPrice: num("PAIR_MAX_PRICE", 0.75),
    /** Leg 2 walks the other token's asks up to this far over its best: it must fill, the pair is open until it does. */
    closeSlip: num("PAIR_CLOSE_SLIP", 0.05),
    /** Leg 2 goes at once, whatever the hold, this many seconds before the close. */
    closeLeftSec: num("PAIR_CLOSE_LEFT_SEC", 15),
  },
};

export type Config = typeof CFG;

/** The knobs the live dashboard's BASE | CHALLENGER switch (profile.ts) takes from the paper bot's or the challenger's
 *  config while the bot runs: the race / depth-cap rules, the cancel-decision speed-ups, the lock and stop, and the quote
 *  stop. The engine rebuilds what it derives from them (engine.ts rebuildKnobs) at the next window. Everything else
 *  (size, cap, the venue, the wallet, the loss limit) stays the bot's own. */
export const SWITCH_KEYS = [
  "MM_RACE_SHARE", "MM_RACE_INFLIGHT", "MM_JOIN_MAX_SH", "MM_JOIN_MAX_REL", "MM_JOIN_REF_MS",
  "MM_DECIDE_EVENTS", "MM_DECIDE_FV", "MM_LOCK_PCT", "MM_LOCK_PX_F", "MM_LOCK_PX_MIN_NET",
  "MM_V4_QUOTE_UNTIL_LEFT_SEC", "MM_V4_REDUCE_ONLY_LEFT_SEC", "FLOW_FV_SCALE_RISE", "FLOW_FV_SCALE_FALL",
] as const;
export type SwitchKey = (typeof SWITCH_KEYS)[number];

/** SWITCH_KEYS read from process.env again into CFG, with the parsers and defaults CFG uses above (selftest checks they
 *  agree). Every value is parsed before any is set, so a bad one throws with CFG unchanged. */
export function reloadSwitchKnobs(): void {
  const top = {
    raceShare: numOff("MM_RACE_SHARE", 0.2),
    raceInflight: onOff("MM_RACE_INFLIGHT", "off"),
    joinMaxSh: optNum("MM_JOIN_MAX_SH"),
    joinRel: optNum("MM_JOIN_MAX_REL"),
    joinRefMs: num("MM_JOIN_REF_MS", 30_000),
    decideEvents: oneOf("MM_DECIDE_EVENTS", ["off", "book", "all"] as const, "off"),
    decideFv: oneOf("MM_DECIDE_FV", ["frame", "fresh"] as const, "frame"),
    v4QuoteUntilLeftSec: num("MM_V4_QUOTE_UNTIL_LEFT_SEC", 30),
    v4ReduceOnlyLeftSec: optNum("MM_V4_REDUCE_ONLY_LEFT_SEC"),
    flowFvScaleRise: num("FLOW_FV_SCALE_RISE", num("FLOW_FV_SCALE", 2)),
    flowFvScaleFall: num("FLOW_FV_SCALE_FALL", num("FLOW_FV_SCALE", 2)),
  };
  const lock = { pct: optNum("MM_LOCK_PCT"), pxF: optNum("MM_LOCK_PX_F"), pxMinNet: num("MM_LOCK_PX_MIN_NET", 2) };
  Object.assign(CFG, top);
  Object.assign(CFG.lock, lock);
}

/** KEY=value lines of an env file, for profile.ts (the .env the other apps read). */
export const envFile = readEnvFile;
