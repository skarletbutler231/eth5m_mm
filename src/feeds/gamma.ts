// Polymarket Gamma: market discovery per 5-minute window, and the authoritative outcome.
import { slugOf } from "../asset.js";

const GAMMA = "https://gamma-api.polymarket.com";
export const WIN = 300;

export interface Market {
  marketId: string;
  slug: string;
  conditionId: string;
  upToken: string;    // outcomes ["Up","Down"] -> index 0
  downToken: string;
  tickSize: number;
  minSize: number;
  twapSec: 30 | 60;   // cryptoMarketConfig.twapLookbackSeconds: the settlement average, read per market
  startTs: number;
  endTs: number;
}

export async function fetchMarket(startTs: number): Promise<Market | null> {
  const r = await fetch(`${GAMMA}/markets?slug=${slugOf(startTs)}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  const m = arr[0];
  const toks = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
  if (!Array.isArray(toks) || toks.length < 2) return null;
  const outs = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
  const upIdx = Array.isArray(outs) && String(outs[1]).toLowerCase() === "up" ? 1 : 0;
  const lb = Number(m.cryptoMarketConfig?.twapLookbackSeconds);
  return {
    marketId: String(m.id), slug: String(m.slug), conditionId: String(m.conditionId ?? ""),
    upToken: String(toks[upIdx]), downToken: String(toks[1 - upIdx]),
    tickSize: Number(m.orderPriceMinTickSize) || 0.01, minSize: Number(m.orderMinSize) || 5,
    twapSec: lb === 30 ? 30 : 60, startTs, endTs: startTs + WIN,
  };
}

export interface Outcome { up: boolean; priceToBeat: number | null }

/** Polymarket's own payout once the market is closed; null while unresolved. */
export async function fetchOutcome(startTs: number): Promise<Outcome | null> {
  const r = await fetch(`${GAMMA}/events?slug=${slugOf(startTs)}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const ev = await r.json();
  const e = Array.isArray(ev) && ev.length ? ev[0] : null;
  const m = e?.markets?.[0];
  if (!m || !m.closed) return null;
  const op = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
  if (!Array.isArray(op) || op.length !== 2) return null;
  const outs = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
  const upIdx = Array.isArray(outs) && String(outs[1]).toLowerCase() === "up" ? 1 : 0;
  if (String(op[upIdx]) !== "1" && String(op[1 - upIdx]) !== "1") return null;   // not final yet
  const ptb = Number(e?.eventMetadata?.priceToBeat);
  return { up: String(op[upIdx]) === "1", priceToBeat: Number.isFinite(ptb) && ptb > 0 ? ptb : null };
}

// ⛔ Do not use polymarket.com/api/crypto/crypto-price as a strike. Its `openPrice`/`closePrice` are
// Chainlink SPOT at the boundaries, not the TWAP the market settles on (2026-10-07, window 1791395700:
// openPrice 83105.84 = the spot report at +0 s; Gamma eventMetadata.priceToBeat 83114.05 = the TWAP60
// report at +0 s). Gamma's priceToBeat is the real strike but appears only after the close.
