// The one asset this bot makes markets in: every venue symbol, the Polymarket slug and the app names in one place.
// Ported from btc5m_mm_bot (2026-11-18), where each of these was a hard-coded BTC string. MM_ASSET picks a preset
// (default eth); the same code still runs the BTC market with MM_ASSET=btc.
//
// Checked live 2026-11-18 for ETH: Gamma eth-updown-5m-<start> (cryptoMarketConfig eth-5m-twap-60: the 60 s TWAP,
// 1¢ tick, 5-share minimum, as BTC), RTDS eth/usd on crypto_prices_chainlink and crypto_prices_twap_sixty (no
// crypto_prices_twap_thirty updates for ETH), Binance ETHUSDT spot and USD-M perp bookTicker, Coinbase ETH-USD.
import "./config.js";   // .env loaded (config.ts loadEnv) before MM_ASSET is read below

export interface Asset {
  /** Lower-case key: the preset's name and the app-name prefix ("eth" → eth5m-mm-bot). */
  key: string;
  /** Upper-case ticker for logs and the dashboard. */
  name: string;
  /** Long name, as in Polymarket's question ("Ethereum Up or Down"). */
  long: string;
  /** Gamma slug of a window: `${slugPrefix}-${startTs}`. */
  slugPrefix: string;
  /** Chainlink symbol on Polymarket's RTDS relay. */
  chainlink: string;
  /** Binance spot and USD-M perp symbol (bookTicker streams take it lower-case). */
  binance: string;
  /** Coinbase Advanced Trade product. */
  coinbase: string;
  /** CryptoStruct binance_swap instrument id; 0 = looked up in the instrument directory by `binance` at boot. */
  csPerpId: number;
}

const PRESETS: Record<string, Asset> = {
  eth: { key: "eth", name: "ETH", long: "Ethereum", slugPrefix: "eth-updown-5m", chainlink: "eth/usd", binance: "ETHUSDT", coinbase: "ETH-USD", csPerpId: 0 },
  btc: { key: "btc", name: "BTC", long: "Bitcoin", slugPrefix: "btc-updown-5m", chainlink: "btc/usd", binance: "BTCUSDT", coinbase: "BTC-USD", csPerpId: 67824 },
};

function pick(): Asset {
  const k = (process.env.MM_ASSET || "eth").trim().toLowerCase();
  const a = PRESETS[k];
  if (!a) throw new Error(`MM_ASSET=${k}: expected ${Object.keys(PRESETS).join(" or ")}`);
  return a;
}

/** Read at import, after config.ts has loaded .env (the import above). */
export const ASSET: Asset = pick();

/** The pm2 / log name of this bot's apps: eth5m-mm-bot, eth5m-mm-live, eth5m-mm-challenger, eth5m-pair, … */
export const app = (suffix: string): string => `${ASSET.key}5m-${suffix}`;

export const slugOf = (startTs: number): string => `${ASSET.slugPrefix}-${startTs}`;
