// PRICERS — the model FV a frame computes (engine.tick), as a pure function so the decide step can recompute it between
// frames on the latest Binance mids (MM_DECIDE_FV=fresh) with exactly the frame's rules:
//   fvr   the anchored FV on the nowcast path (Binance/Coinbase blend, or whichever is fresh) when the window has a
//         Chainlink strike and Chainlink is fresh; else the venue FV on Binance against the Binance strike
//   fvbr  the same anchored FV on Binance alone (the flow FV's pricer input); null unless fvr is anchored
import { fairValueAnchored, fairValueVenue, venuePath, type FvResult, type StampPath } from "./model/fairValue.js";
import type { PriceBuffer } from "./model/priceBuffer.js";
import { normCdf, normInv } from "./model/math.js";

export interface PricerIn {
  now: number;
  /** Chainlink strike / Binance strike of the window (null = unknown). */
  Kcl: number | null; Kv: number | null;
  endMs: number; D: number;
  sigma: number | null; eps2: number;
  /** Chainlink prints (rtds.spot) and whether they are fresh. */
  cl: PriceBuffer; clFresh: boolean;
  /** Binance mids, their lag (ms) and freshness. */
  bin: PriceBuffer; L: number; binFresh: boolean;
  /** The nowcast path (engine.nowcastPath): null = no venue fresh. */
  nc: { path: StampPath; src: string } | null;
}

export function framePricers(x: PricerIn): { fvr: FvResult | null; fvbr: FvResult | null } {
  let fvr: FvResult | null = null, fvbr: FvResult | null = null;
  if (x.sigma != null) {
    if (x.nc && x.Kcl != null && x.clFresh) {
      const a = { now: x.now, K: x.Kcl, endMs: x.endMs, D: x.D, sigma: x.sigma, eps2: x.eps2, cl: x.cl };
      fvr = fairValueAnchored({ ...a, path: x.nc.path });
      // the same FV on Binance alone, scored next to the blend
      fvbr = x.nc.src === "binance" ? fvr : x.binFresh ? fairValueAnchored({ ...a, path: venuePath(x.bin, x.L) }) : null;
    }
    if (!fvr && x.Kv != null && x.binFresh) fvr = fairValueVenue(x.bin, x.now, x.Kv, x.endMs, x.D, x.L, x.sigma, x.eps2);
  }
  if (fvr?.src !== "anchored") fvbr = null;
  return { fvr, fvbr };
}

export interface Anchor { z: number; m: number; sd: number; mid: number }

/** The market-anchored FV (last good mid carried forward by the model's move since), as the frame computes it, without
 *  moving the frame's anchor: on a good book whose mid differs from the anchor's, the anchor would reset to that mid,
 *  so the anchored FV is the mid itself. */
export function anchoredFv(anchor: Anchor | null, fvr: FvResult | null, mid: number | null, good: boolean): number | null {
  if (!fvr) return null;
  if (good && mid != null && (!anchor || anchor.mid !== mid)) return normCdf(normInv(mid));
  return anchor ? normCdf((anchor.z * anchor.sd + (fvr.m - anchor.m)) / fvr.sd) : null;
}
