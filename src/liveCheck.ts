// `npm run live:check` — read-only check of the live wallet before MM_MODE=live: connects with the wallet vault's key (asks
// its passphrase), reads the collateral balance and opens the user channel for a few seconds. Places, cancels and moves nothing.
import "./config.js";   // loads .env
import { connectVenue } from "./trading/venue.js";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);

const v = await connectVenue(log);
log(`[check] wallet ${v.wallet}`);
log(`[check] collateral $${(await v.balance()).toFixed(2)}`);
const t0 = Date.now();
while (!v.connected() && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 250));
log(v.connected() ? `[check] user channel up after ${Date.now() - t0} ms` : "[check] ✗ user channel did not connect in 15 s");
await v.close();
process.exit(v.connected() ? 0 : 1);
