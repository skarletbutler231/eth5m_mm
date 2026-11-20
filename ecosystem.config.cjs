// pm2 config:  pm2 start ecosystem.config.cjs --only eth5m-mm-bot   ·   pm2 logs eth5m-mm-bot   ·   pm2 restart eth5m-mm-bot
// LIVE (real money): bash tools/start-live.sh   ·   pm2 logs eth5m-mm-live   ·   pm2 stop eth5m-mm-live (cancels its orders)
// The ETH 5-minute port of btc5m_mm_bot (2026-11-18). Ports 8040-8045 (the BTC bot has 8030-8035), data dirs as there.
// tsx needs a modern Node, and this box has no system `node` (nvm only), so the interpreter is resolved
// to the newest Node >= 20 under nvm (override with NODE_BIN=/path/to/node/bin). The live app needs >= 24
// (@polymarket/client: the global WebSocket of its user channel; under v20 the channel never connects and no order goes).
// An app whose Node is missing is left out with a warning instead of failing the whole file, so the other still starts.
const path = require("path");
const fs = require("fs");
const os = require("os");

function modernNode(min = 20) {
  if (process.env.NODE_BIN) return path.join(process.env.NODE_BIN, "node");
  if (parseInt(process.versions.node.split(".")[0], 10) >= min) return process.execPath;
  const nvm = path.join(os.homedir(), ".nvm/versions/node");
  const best = fs.readdirSync(nvm)
    .map((v) => v.match(/^v(\d+)\.(\d+)\.(\d+)$/)).filter(Boolean)
    .map((m) => ({ v: m[0], k: m.slice(1).map(Number) })).filter((x) => x.k[0] >= min)
    .sort((a, b) => b.k[0] - a.k[0] || b.k[1] - a.k[1] || b.k[2] - a.k[2])[0];
  if (!best) throw new Error(`no Node >= ${min} under ${nvm} (nvm install ${min}, or set NODE_BIN)`);
  return path.join(nvm, best.v, "bin", "node");
}

function withNode(app, min) {
  try {
    return { ...app, interpreter: modernNode(min) };
  } catch (e) {
    console.error(`[ecosystem] skipping ${app.name}: ${e.message}`);
    return null;
  }
}

const base = {
  cwd: __dirname,
  script: path.join(__dirname, "node_modules/tsx/dist/cli.mjs"),
  args: "src/index.ts",
  max_memory_restart: "1500M",
  time: false,
};

module.exports = {
  apps: [
    withNode({
      // THE PAPER BOT: .env (PORT 8040, data/) plus the knobs below — btc5m-mm-bot's settings of 2026-11-18 (v6-jrel150),
      // with ETH's order size 20 / cap 40 from .env.
      ...base,
      name: "eth5m-mm-bot",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      kill_timeout: 5000,
      env: {
        MM_ASSET: "eth",
        MM_TAG: "eth-v6-jrel150",
        MM_RACE_INFLIGHT: "on",
        MM_JOIN_MAX_REL: "1.5",
      },
    }, 20),
    withNode({
      // REAL ORDERS from the wallet (key in the wallet vault), beside the paper bot: own dashboard port and data dir (seeded
      // by tools/start-live.sh). These env vars override .env. A crash restarts it (it cancels the last run's saved orders
      // first), at most 5 times. Strategy knobs = btc5m-mm-live's v8 of 2026-11-18; sizes smaller (10 a side, cap 20) until
      // the ETH paper record says otherwise.
      ...base,
      name: "eth5m-mm-live",
      autorestart: true,
      max_restarts: 5,
      min_uptime: "60s",
      restart_delay: 10000,
      kill_timeout: 8000,
      env: {
        MM_ASSET: "eth",
        MM_MODE: "live",
        PORT: "8041",
        DATA_DIR: "data-live",
        MM_ORDER_SIZE: "10",
        MM_MAX_POSITION: "20",
        MM_CAP_PENDING: "on",
        LIVE_MAX_LOSS: "20",
        LIVE_LOSS_ON: "settled",
        // ⚠ ON A WALLET ANOTHER BOT TRADES TOO (the BTC bots): list their live state.json files here, comma-separated, so the
        // wallet check counts their booked tokens (src/trading/peers.ts); otherwise their positions read as a wallet gap
        // LIVE_PEER_STATE: "/home/david-work/btc5m_mm_bot/data-live/live/state.json",
        // the session schedule (src/control.ts): the order size a side (cap 2×) or "stop" by the UTC hour a window opens in.
        // MM_SESSIONS: "0-3=20,13-16=20,*=10",
        LIVE_EARLY_CANCEL: "on",
        PM_SOCKETS: "2",
        LIVE_POST_COPIES: "3",
        MM_RACE_SHARE: "0.5",
        MM_TOLERATE_TICKS: "2",
        MM_RACE_ON_BOOK: "on",
        LIVE_CANCEL_HTTP: "own",
        MM_JOIN_MAX_REL: "1.5",
        MM_RACE_INFLIGHT: "off",
        MM_DECIDE_EVENTS: "off",
        MM_DECIDE_FV: "frame",
        MM_TAG: "eth-v8-live",
      },
    }, 24),
    withNode({
      // THE PAPER CHALLENGER, beside eth5m-mm-bot: its own port, data dir and paper account; also the live dashboard's
      // CHALLENGER profile (src/profile.ts: choosing it there puts this app's race / depth-cap / quote-stop knobs on live).
      // pm2 stop / pm2 delete eth5m-mm-challenger.
      // The FILL-RATE A/B since 2026-11-18 ~11:50 UTC (the user's request): eth5m-mm-bot's settings (.env + its env above)
      // plus only the four changes below. Why: its first 3 windows filled nothing; against the real ETH trades, its bids sat
      // behind a median ~90 sh (ETH trades are 11–28 sh), re-pricing left 23 trades' levels and the race / depth gates 14
      // (of 120 trades). Compare with eth5m-mm-bot over ~100 paired windows: fills, PnL, 1 / 5 / 30 s markouts.
      ...base,
      name: "eth5m-mm-challenger",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      kill_timeout: 5000,
      env: {
        MM_ASSET: "eth",
        MM_MODE: "paper", PORT: "8044", DATA_DIR: "data-challenger", TWIN_PORT: "off",
        // as eth5m-mm-bot
        MM_RACE_INFLIGHT: "on",
        // 1. a working order within 2 ticks of its target keeps its queue spot (paper bot: 1)
        MM_TOLERATE_TICKS: "2",
        // 2. maker quotes until 120 s before the close, i.e. to 180 s elapsed (paper bot: 150 → to 150 s)
        MM_V4_QUOTE_UNTIL_LEFT_SEC: "120",
        // 3. no race cancels / race join gate (paper bot: share 0.4 from .env, level 0.5 by default)
        MM_RACE_SHARE: "off",
        MM_RACE_LEVEL: "off",
        // 4. no depth cap (paper bot: 1.5 × the median best size over 30 s)
        MM_JOIN_MAX_REL: "off",
        MM_TAG: "eth-fill1",
      },
    }, 20),
  ].filter(Boolean),
};
