// The bot's own Chainlink feed class live for SECS seconds: which transport, ticks, receive lag, TWAP reports.
//   set -a; . ./.env; set +a; npx tsx tools/polybolt/feedcheck.ts [secs]      (POLYBOLT_API_KEY unset = RTDS)
import { RtdsFeed } from "../../src/feeds/rtds.js";

const secs = Number(process.argv[2] ?? 30), e = process.env;
const pb = e.POLYBOLT_API_KEY ? { apiKey: e.POLYBOLT_API_KEY, secret: e.POLYBOLT_SECRET ?? "", passphrase: e.POLYBOLT_PASSPHRASE ?? "", chainlinkKey: e.CHAINLINK_API_KEY || undefined } : null;
const f = new RtdsFeed((m) => console.log(new Date().toISOString().slice(11, 23), m), pb);
const lags: number[] = [];
let lastTs = 0;
setInterval(() => { const t = f.spotLatest; if (t && t.ts !== lastTs) { lastTs = t.ts; lags.push(t.rx - t.ts); } }, 50).unref();
f.start();
setTimeout(() => {
  const s = [...lags].sort((a, b) => a - b), now = Math.floor(Date.now() / 1000);
  console.log(`kind ${f.kind}, connected ${f.connected}, reconnects ${f.reconnects}, lastError "${f.lastError}"`);
  console.log(`spot buffer ${f.spot.length} pts, last ${f.spot.last()}; spot rx-ts p50 ${s[s.length >> 1]} ms (n ${s.length})`);
  console.log(`TWAP report 10 s ago: ${JSON.stringify(f.reportAt(now - 10, 60))}, 100 s ago: ${JSON.stringify(f.reportAt(now - 100, 60))}`);
  process.exit(0);
}, secs * 1000);
